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

  function clickIcon(bubble, iconNames) {
    for (const name of iconNames) {
      const icon = bubble.querySelector(`[data-icon="${name}"]`);
      if (icon) {
        (icon.closest("button, [role='button']") || icon).click();
        return true;
      }
    }
    return false;
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
    let lastFetchError = null;
    try {
      if (!clickIcon(bubble, ["audio-play", "ptt-play"])) {
        console.warn("[WAT] bouton play introuvable dans la bulle");
        return null;
      }

      // Le fichier complet est disponible dès le début de la lecture : inutile
      // d'écouter tout le message. On tente le téléchargement dès qu'un blob
      // apparaît, tant qu'il est encore vivant.
      for (let i = 0; i < 100; i++) {
        await sleep(80);
        const a = findBlobAudio();
        if (!a) continue;
        silence(a);
        const src = a.currentSrc || a.src;
        if (!src || src === beforeSrc) continue; // pas encore le nouveau média

        try {
          const resp = await fetch(src);
          const buf = await resp.arrayBuffer();
          if (buf.byteLength) {
            result = {
              buf,
              mime: resp.headers.get("content-type") || "audio/ogg",
            };
            break;
          }
        } catch (e) {
          lastFetchError = e;
          // Blob MediaSource (flux) → non téléchargeable via fetch.
          console.warn("[WAT] fetch du blob échoué :", e && e.message);
        }
      }

      if (!result) {
        dumpAudioState("ÉCHEC récupération");
        if (lastFetchError) {
          console.warn(
            "[WAT] Dernière erreur fetch :",
            lastFetchError && lastFetchError.message
          );
        }
      }
      return result;
    } finally {
      const a = findBlobAudio() || shared;
      if (a) {
        try {
          a.pause();
          a.currentTime = 0;
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
