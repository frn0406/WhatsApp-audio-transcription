/*
 * Transcription Audio WhatsApp — content script
 *
 * Détecte les messages vocaux dans WhatsApp Web, injecte un bouton
 * « Transcrire » et affiche le texte renvoyé par Whisper (OpenAI / Groq).
 *
 * Volontairement léger : aucune dépendance, pas de framework.
 *
 * Note DOM (2026) : WhatsApp Web n'insère plus de balise <audio> par
 * message tant que le vocal n'est pas lu. On s'ancre donc sur le curseur
 * de lecture ([role="slider"][aria-valuetext]) et le bouton play
 * ([data-icon="audio-play"]), toujours présents. Le blob audio n'est
 * récupéré qu'au clic, en déclenchant brièvement la lecture.
 */

(() => {
  "use strict";

  const PROCESSED = "watDone"; // marqueur anti-doublon (sur la bulle)
  const LABEL_IDLE = "🎙️ Transcrire";
  const LABEL_LOADING = "⏳ Transcription…";

  // Éléments qui identifient un message vocal / audio.
  const VOICE_SELECTOR = [
    '[role="slider"][aria-valuetext]',
    '[data-icon="audio-play"]',
    '[data-icon="ptt-play"]',
  ].join(",");

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Injecte injected.js dans le contexte de la page (pour patcher play() et
  // forcer le mode muet). Méthode <script> compatible toutes versions de
  // Chrome, contrairement à la clé manifest "world": "MAIN".
  function injectPageScript() {
    try {
      const s = document.createElement("script");
      s.src = chrome.runtime.getURL("injected.js");
      s.onload = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      console.warn("[WAT] injection du script page impossible :", e);
    }
  }

  // --- Utilitaires ---------------------------------------------------------

  function arrayBufferToBase64(buffer) {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  // Remonte jusqu'à la bulle du message (ancre le bouton + clé de cache).
  function findBubble(el) {
    return (
      el.closest(".message-in, .message-out") ||
      el.closest("[data-id]") ||
      el.parentElement
    );
  }

  function messageKey(bubble) {
    return bubble.closest("[data-id]")?.getAttribute("data-id") || null;
  }

  // WhatsApp utilise un lecteur <audio> partagé ; on cherche celui qui
  // pointe sur un blob.
  function findBlobAudio() {
    for (const a of document.querySelectorAll("audio")) {
      const src = a.currentSrc || a.src || "";
      if (src.startsWith("blob:")) return a;
    }
    return null;
  }

  // Coupe immédiatement le son d'un élément <audio>.
  function silence(a) {
    if (!a) return;
    try {
      a.muted = true;
      a.volume = 0;
    } catch (_) {}
  }

  // Trouve le contrôle « play » du vocal, quelle que soit la variante du DOM :
  // icône data-icon contenant "play", ou bouton avec un aria-label parlant
  // (« Lire le message vocal », « Play voice message », etc.).
  function findPlayControl(bubble) {
    const icon = bubble.querySelector(
      '[data-icon*="play" i]:not([data-icon*="pause" i])'
    );
    if (icon) return icon.closest("button, [role='button']") || icon;

    const RX_PLAY = /(lire|play|écouter|ecouter|reproduc|abspiel|riprodu)/i;
    const candidates = bubble.querySelectorAll(
      "button[aria-label], [role='button'][aria-label]"
    );
    for (const el of candidates) {
      const label = el.getAttribute("aria-label") || "";
      if (RX_PLAY.test(label) && !/pause/i.test(label)) return el;
    }
    return null;
  }

  // Diagnostic : liste les attributs réellement présents dans la bulle.
  function dumpBubbleControls(bubble) {
    console.warn(
      "[WAT] contrôles présents dans la bulle — data-icons :",
      [...bubble.querySelectorAll("[data-icon]")].map((e) =>
        e.getAttribute("data-icon")
      ),
      "| aria-labels :",
      [...bubble.querySelectorAll("[aria-label]")].map((e) =>
        e.getAttribute("aria-label")
      ),
      "| boutons :",
      bubble.querySelectorAll("button, [role='button']").length
    );
  }

  // --- Canal de récupération des médias capturés par injected.js ----------

  let mediaReqId = 0;
  const mediaPending = new Map();

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.type !== "WAT_MEDIA") return;
    const resolve = mediaPending.get(event.data.id);
    if (resolve) {
      mediaPending.delete(event.data.id);
      resolve(event.data);
    }
  });

  // Envoie une requête à injected.js et attend sa réponse (null si délai).
  function sendToPage(payload) {
    return new Promise((resolve) => {
      const id = ++mediaReqId;
      const timer = setTimeout(() => {
        mediaPending.delete(id);
        resolve(null);
      }, 3000);
      mediaPending.set(id, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
      window.postMessage(Object.assign({ id }, payload), "*");
    });
  }

  // Octets (ou juste la taille) capturés pour une URL de média.
  function getCapturedMedia(url, sizeOnly) {
    return sendToPage({ type: "WAT_GET_MEDIA", url, sizeOnly: !!sizeOnly });
  }

  // Journalise l'état de tous les éléments <audio> (diagnostic).
  function dumpAudioState(tag) {
    const els = [...document.querySelectorAll("audio")];
    console.log(
      `[WAT] ${tag} — ${els.length} <audio> :`,
      els.map((a) => ({
        src: a.src,
        currentSrc: a.currentSrc,
        srcObject: a.srcObject ? a.srcObject.constructor.name : null,
        readyState: a.readyState,
        networkState: a.networkState,
        duration: a.duration,
        paused: a.paused,
      }))
    );
  }

  // Déclenche (silencieusement) la lecture pour forcer WhatsApp à charger le
  // média, et demande à injected.js d'en extraire les octets — quelle que soit
  // la tuyauterie (Blob, MediaSource par URL ou par srcObject, élément hors
  // DOM). Renvoie { buf, mime } ou null. Aucun son n'est joué.
  async function grabAudio(bubble) {
    window.postMessage({ type: "WAT_FORCE_MUTE" }, "*");

    let result = null;
    try {
      const playCtl = findPlayControl(bubble);
      if (!playCtl) {
        console.warn("[WAT] bouton play introuvable dans la bulle");
        dumpBubbleControls(bubble);
        return null;
      }
      playCtl.click();

      // Phase A : attend que des octets soient disponibles (≤ 15 s).
      let info = null;
      for (let i = 0; i < 150; i++) {
        await sleep(100);
        const r = await sendToPage({ type: "WAT_GRAB", sizeOnly: true });
        if (r && r.ok && r.size > 0) {
          info = r;
          break;
        }
      }
      if (!info) {
        const r = await sendToPage({ type: "WAT_GRAB", sizeOnly: true });
        console.warn("[WAT] aucun octet capturé — diagnostic :", r);
        dumpAudioState("échec détection");
        return null;
      }
      console.log(
        "[WAT] capture en cours :", info.kind + ",",
        info.size, "octets, flux clos :", !!info.ended
      );

      // Accélère la lecture muette pour charger vite un flux progressif.
      await sendToPage({ type: "WAT_CONTROL", action: "rate", rate: 16 });

      // Phase B : attend la fin du flux ou la stabilité de la taille (≤ 2 min).
      let lastSize = info.size;
      let stableRounds = 0;
      for (let i = 0; i < 800 && !info.ended; i++) {
        await sleep(150);
        const r = await sendToPage({ type: "WAT_GRAB", sizeOnly: true });
        if (!r || !r.ok) break;
        info = r;
        if (r.size === lastSize) {
          if (++stableRounds >= 14) break; // ~2 s sans nouvel octet
        } else {
          stableRounds = 0;
          lastSize = r.size;
        }
      }

      const media = await sendToPage({ type: "WAT_GRAB", sizeOnly: false });
      if (media && media.ok && media.buffer && media.buffer.byteLength) {
        console.log(
          "[WAT] récupéré via", media.kind + ",",
          media.buffer.byteLength, "octets, mime :", media.mime
        );
        return (result = {
          buf: media.buffer,
          mime: (media.mime || "audio/ogg").split(";")[0],
        });
      }

      console.warn("[WAT] ÉCHEC récupération — réponse :", media);
      dumpAudioState("ÉCHEC récupération");
      return null;
    } finally {
      // Stoppe ET démute tous les lecteurs traqués, succès ou échec — pour ne
      // jamais laisser WhatsApp muté pour l'utilisateur.
      await sendToPage({ type: "WAT_CONTROL", action: "stopAll" });
      window.postMessage({ type: "WAT_FORCE_UNMUTE" }, "*");
    }
  }

  function showResult(container, text, isError) {
    let box = container.querySelector(".wat-result");
    if (!box) {
      box = document.createElement("div");
      box.className = "wat-result";
      container.appendChild(box);
    }
    box.classList.toggle("wat-error", !!isError);
    box.textContent = text;
    return box;
  }

  function showSummary(bar, text) {
    let box = bar.querySelector(".wat-summary");
    if (!box) {
      box = document.createElement("div");
      box.className = "wat-summary";
      bar.appendChild(box);
    }
    box.textContent = text;
    return box;
  }

  // Ajoute (une seule fois) le bouton « Résumer » sous une transcription.
  function ensureSummaryButton(bar, key, transcript) {
    if (!transcript || bar.querySelector(".wat-sum-btn")) return;

    const btn = document.createElement("button");
    btn.className = "wat-btn wat-sum-btn";
    btn.type = "button";
    btn.textContent = "📝 Résumer";
    bar.appendChild(btn);

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "⏳ Résumé…";
      try {
        const answer = await chrome.runtime.sendMessage({
          type: "summarize",
          text: transcript,
          key,
        });
        if (!answer) throw new Error("Aucune réponse du service worker.");
        if (!answer.ok) throw new Error(answer.error || "Erreur inconnue.");
        showSummary(bar, answer.summary || "(vide)");
        btn.textContent = "✅ Résumé";
      } catch (err) {
        showSummary(bar, "⚠️ " + err.message);
        btn.textContent = "📝 Résumer";
        btn.disabled = false;
      }
    });
  }

  // --- Cœur : transcription d'un message ----------------------------------

  async function transcribe(bubble, btn, bar) {
    btn.disabled = true;
    btn.textContent = LABEL_LOADING;
    showResult(bar, "Transcription en cours…", false);

    try {
      const grabbed = await grabAudio(bubble);
      if (!grabbed) {
        throw new Error(
          "Audio introuvable (voir la console F12 pour le diagnostic)."
        );
      }

      const { buf, mime } = grabbed;
      const audioBase64 = arrayBufferToBase64(buf);

      const answer = await chrome.runtime.sendMessage({
        type: "transcribe",
        audioBase64,
        mime,
        key: messageKey(bubble),
      });

      if (!answer) throw new Error("Aucune réponse du service worker.");
      if (!answer.ok) throw new Error(answer.error || "Erreur inconnue.");

      showResult(bar, answer.text || "(vide)", false);
      btn.textContent = "✅ Transcrit";
      ensureSummaryButton(bar, messageKey(bubble), answer.text);
    } catch (err) {
      showResult(bar, "⚠️ " + err.message, true);
      btn.textContent = LABEL_IDLE;
      btn.disabled = false;
    }
  }

  // --- Injection du bouton -------------------------------------------------

  async function injectFor(anchor) {
    const bubble = findBubble(anchor);
    if (!bubble || bubble.dataset[PROCESSED]) return;
    bubble.dataset[PROCESSED] = "1";

    const bar = document.createElement("div");
    bar.className = "wat-bar";

    const btn = document.createElement("button");
    btn.className = "wat-btn";
    btn.type = "button";
    btn.textContent = LABEL_IDLE;
    bar.appendChild(btn);
    bubble.appendChild(bar);
    console.debug("[WAT] bouton injecté sur un message vocal");

    // Affiche une transcription déjà en cache le cas échéant.
    const key = messageKey(bubble);
    if (key) {
      try {
        const cache = await chrome.runtime.sendMessage({ type: "getCache", key });
        if (cache && cache.text) {
          showResult(bar, cache.text, false);
          btn.textContent = "✅ Transcrit";
          ensureSummaryButton(bar, key, cache.text);
          if (cache.summary) {
            showSummary(bar, cache.summary);
            const sumBtn = bar.querySelector(".wat-sum-btn");
            if (sumBtn) sumBtn.textContent = "✅ Résumé";
          }
        }
      } catch (_) {}
    }

    btn.addEventListener("click", () => transcribe(bubble, btn, bar));
  }

  function scan(root) {
    if (root.nodeType !== 1) return;
    if (root.matches?.(VOICE_SELECTOR)) injectFor(root);
    root.querySelectorAll?.(VOICE_SELECTOR).forEach(injectFor);
  }

  // --- Observation du DOM WhatsApp ----------------------------------------

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((n) => scan(n));
    }
  });

  injectPageScript();
  observer.observe(document.body, { childList: true, subtree: true });
  scan(document.body); // premier passage

  // Filet de sécurité : re-scan périodique (WhatsApp virtualise la liste des
  // messages ; certains vocaux peuvent apparaître sans mutation observée).
  let ticks = 0;
  const poll = setInterval(() => {
    scan(document.body);
    if (++ticks > 40) clearInterval(poll); // ~2 min puis on s'arrête
  }, 3000);

  console.debug(
    "[WAT] content script chargé — anchors vocaux détectés :",
    document.querySelectorAll(VOICE_SELECTOR).length
  );
})();
