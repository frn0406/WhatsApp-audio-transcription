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
  // média, le télécharge PENDANT la lecture (avant toute pause/révocation du
  // blob), puis remet en pause. Renvoie { buf, mime } ou null. Aucun son n'est
  // joué : injected.js force le mode muet dès le premier appel à play().
  async function grabAudio(bubble) {
    window.postMessage({ type: "WAT_FORCE_MUTE" }, "*");

    const shared = document.querySelector("audio");
    const restore = shared
      ? { el: shared, muted: shared.muted, volume: shared.volume }
      : null;
    silence(shared);

    const before = findBlobAudio();
    const beforeSrc = before ? before.currentSrc || before.src : null;

    dumpAudioState("avant clic play");

    let result = null;
    let url = null;
    try {
      const playCtl = findPlayControl(bubble);
      if (!playCtl) {
        console.warn("[WAT] bouton play introuvable dans la bulle");
        dumpBubbleControls(bubble);
        return null;
      }
      playCtl.click();

      // 1. Attend qu'un média démarre avec une source blob. On interroge
      // injected.js, qui voit TOUS les médias ayant appelé play() — y compris
      // les Audio() créés en JS et jamais attachés au DOM, invisibles pour
      // querySelectorAll("audio").
      for (let i = 0; i < 120 && !url; i++) {
        await sleep(80);
        const playing = await sendToPage({ type: "WAT_GET_PLAYING" });
        const list = (playing && playing.media) || [];
        // Le plus récent d'abord.
        for (let j = list.length - 1; j >= 0; j--) {
          const src = list[j].currentSrc || list[j].src || "";
          if (src.startsWith("blob:") && src !== beforeSrc) {
            url = src;
            break;
          }
        }
        if (!url) {
          // Repli DOM classique.
          const a = findBlobAudio();
          if (a) {
            silence(a);
            const src = a.currentSrc || a.src;
            if (src) url = src;
          }
        }
      }
      if (!url) {
        const playing = await sendToPage({ type: "WAT_GET_PLAYING" });
        console.warn("[WAT] aucun média blob détecté — médias suivis :",
          playing && playing.media);
        dumpAudioState("aucun média blob détecté");
        return null;
      }
      console.log("[WAT] média détecté :", url);

      // 2. Cas simple : Blob complet, téléchargeable directement.
      try {
        const resp = await fetch(url);
        const buf = await resp.arrayBuffer();
        if (buf.byteLength) {
          console.log("[WAT] récupéré via fetch direct,", buf.byteLength, "octets");
          return (result = {
            buf,
            mime: resp.headers.get("content-type") || "audio/ogg",
          });
        }
      } catch (e) {
        console.log("[WAT] fetch direct impossible (flux MediaSource probable) :", e && e.message);
      }

      // 3. Cas MediaSource : les octets sont capturés par injected.js au fil
      // des appendBuffer. On accélère la lecture muette pour forcer le
      // chargement complet si le flux est progressif, et on attend que la
      // taille capturée se stabilise (ou que le flux soit clos).
      await sendToPage({ type: "WAT_CONTROL", url, action: "rate", rate: 16 });
      let lastSize = 0;
      let stableRounds = 0;
      for (let i = 0; i < 900; i++) {
        const info = await getCapturedMedia(url, true);
        if (info && info.ok && info.size > 0) {
          if (info.ended) break; // flux clos = tout est capturé
          if (info.size === lastSize) {
            if (++stableRounds >= 15) break; // ~2 s sans nouvel octet
          } else {
            stableRounds = 0;
            lastSize = info.size;
          }
        }
        await sleep(120);
      }

      const media = await getCapturedMedia(url, false);
      if (media && media.ok && media.buffer && media.buffer.byteLength) {
        console.log(
          "[WAT] récupéré via capture", media.kind + ",",
          media.buffer.byteLength, "octets, mime:", media.mime
        );
        return (result = {
          buf: media.buffer,
          mime: (media.mime || "audio/ogg").split(";")[0],
        });
      }

      dumpAudioState("ÉCHEC récupération");
      console.warn("[WAT] réponse capture :", media);
      return null;
    } finally {
      // Stoppe le média suivi (même hors DOM) via injected.js.
      if (url) {
        try { await sendToPage({ type: "WAT_CONTROL", url, action: "stop" }); } catch (_) {}
      }
      const a = findBlobAudio() || shared;
      if (a) {
        try {
          a.pause();
          a.currentTime = 0;
          a.playbackRate = 1;
        } catch (_) {}
      }
      if (restore) {
        restore.el.muted = restore.muted;
        restore.el.volume = restore.volume;
      }
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
