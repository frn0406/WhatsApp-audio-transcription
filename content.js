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

  // Déclenche (silencieusement) la lecture pour forcer WhatsApp à charger le
  // blob, récupère l'URL, puis remet immédiatement en pause. Renvoie l'URL
  // blob ou null. Aucun son n'est joué : injected.js force le mode muet dès
  // le premier appel à play().
  async function triggerAndGetBlobUrl(bubble) {
    // Active la coupure forcée du son dans le contexte de la page.
    window.postMessage({ type: "WAT_FORCE_MUTE" }, "*");

    // Coupe aussi tout de suite le lecteur partagé s'il existe déjà, en
    // mémorisant son état pour le restaurer ensuite.
    const shared = document.querySelector("audio");
    const restore = shared
      ? { el: shared, muted: shared.muted, volume: shared.volume }
      : null;
    silence(shared);

    const before = findBlobAudio();
    const beforeSrc = before ? before.currentSrc || before.src : null;

    let audio = null;
    try {
      if (!clickIcon(bubble, ["audio-play", "ptt-play"])) {
        // Pas de bouton play : dernier recours, un blob déjà présent.
        return beforeSrc && beforeSrc.startsWith("blob:") ? beforeSrc : null;
      }

      // Attend l'apparition du blob (le fichier complet est disponible dès le
      // début de la lecture : inutile d'écouter le message en entier).
      for (let i = 0; i < 60; i++) {
        await sleep(80);
        const a = findBlobAudio();
        if (a) {
          silence(a);
          audio = a;
          const src = a.currentSrc || a.src;
          if (src && src !== beforeSrc) break; // nouveau média = le bon
        }
      }
      return audio ? audio.currentSrc || audio.src : null;
    } finally {
      // Stoppe la lecture immédiatement (sans cliquer le bouton pause, ce qui
      // pourrait relancer la lecture) et restaure l'état d'origine.
      const a = audio || findBlobAudio() || shared;
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
      const url = await triggerAndGetBlobUrl(bubble);
      if (!url) {
        throw new Error(
          "Audio introuvable. Lisez le message une fois puis réessayez."
        );
      }

      const resp = await fetch(url);
      const buf = await resp.arrayBuffer();
      if (!buf.byteLength) throw new Error("Fichier audio vide.");

      const audioBase64 = arrayBufferToBase64(buf);
      const mime = resp.headers.get("content-type") || "audio/ogg";

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

  observer.observe(document.body, { childList: true, subtree: true });
  scan(document.body); // premier passage
})();
