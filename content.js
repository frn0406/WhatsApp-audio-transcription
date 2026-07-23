/*
 * Transcription Audio WhatsApp — content script
 *
 * Détecte les messages vocaux dans WhatsApp Web, injecte un bouton
 * « Transcrire » et affiche le texte renvoyé par Whisper (OpenAI / Groq).
 *
 * Volontairement léger : aucune dépendance, pas de framework.
 */

(() => {
  "use strict";

  const BTN_FLAG = "watProcessed"; // dataset flag anti-doublon
  const LABEL_IDLE = "🎙️ Transcrire";
  const LABEL_LOADING = "⏳ Transcription…";

  // --- Utilitaires ---------------------------------------------------------

  function arrayBufferToBase64(buffer) {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(
        null,
        bytes.subarray(i, i + chunk)
      );
    }
    return btoa(binary);
  }

  // Remonte jusqu'à la bulle du message pour ancrer le bouton / le cache.
  function findBubble(audio) {
    return (
      audio.closest(".message-in, .message-out") ||
      audio.closest("[data-id]") ||
      audio.parentElement?.parentElement ||
      audio.parentElement
    );
  }

  // Identifiant stable du message (sert de clé de cache).
  function messageKey(audio) {
    const withId = audio.closest("[data-id]");
    return withId?.getAttribute("data-id") || null;
  }

  // Récupère l'URL blob de l'audio. WhatsApp ne charge parfois le blob
  // qu'au moment de la lecture : on déclenche alors le bouton « play ».
  async function resolveAudioUrl(audio, bubble) {
    const isBlob = (u) => typeof u === "string" && u.startsWith("blob:");
    if (isBlob(audio.currentSrc) || isBlob(audio.src)) {
      return audio.currentSrc || audio.src;
    }

    // Déclenche la lecture pour forcer le chargement du blob.
    const playBtn =
      bubble?.querySelector(
        '[data-icon="audio-play"], [data-icon="ptt-play"]'
      ) || bubble?.querySelector('button[aria-label]');
    const clickable = playBtn?.closest("button, [role='button']") || playBtn;
    if (clickable) clickable.click();

    // Attend l'apparition du blob (max ~4 s).
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (isBlob(audio.currentSrc) || isBlob(audio.src)) {
        // Remet en pause pour ne pas jouer le son à l'utilisateur.
        const pauseBtn = bubble?.querySelector(
          '[data-icon="audio-pause"], [data-icon="ptt-pause"]'
        );
        (pauseBtn?.closest("button, [role='button']") || pauseBtn)?.click();
        try { audio.pause(); } catch (_) {}
        return audio.currentSrc || audio.src;
      }
    }
    return null;
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

  async function transcribe(audio, bubble, btn, resultHost) {
    btn.disabled = true;
    btn.textContent = LABEL_LOADING;
    showResult(resultHost, "Transcription en cours…", false);

    try {
      const url = await resolveAudioUrl(audio, bubble);
      if (!url) throw new Error("Impossible de récupérer l'audio (lisez le message une fois puis réessayez).");

      const resp = await fetch(url);
      const buf = await resp.arrayBuffer();
      if (!buf.byteLength) throw new Error("Fichier audio vide.");

      const audioBase64 = arrayBufferToBase64(buf);
      const mime = resp.headers.get("content-type") || "audio/ogg";

      const answer = await chrome.runtime.sendMessage({
        type: "transcribe",
        audioBase64,
        mime,
        key: messageKey(audio),
      });

      if (!answer) throw new Error("Aucune réponse du service worker.");
      if (!answer.ok) throw new Error(answer.error || "Erreur inconnue.");

      showResult(resultHost, answer.text || "(vide)", false);
      btn.textContent = "✅ Transcrit";
    } catch (err) {
      showResult(resultHost, "⚠️ " + err.message, true);
      btn.textContent = LABEL_IDLE;
      btn.disabled = false;
    }
  }

  // --- Injection du bouton -------------------------------------------------

  async function injectFor(audio) {
    if (audio.dataset[BTN_FLAG]) return;
    audio.dataset[BTN_FLAG] = "1";

    const bubble = findBubble(audio);
    if (!bubble) return;

    const bar = document.createElement("div");
    bar.className = "wat-bar";

    const btn = document.createElement("button");
    btn.className = "wat-btn";
    btn.type = "button";
    btn.textContent = LABEL_IDLE;
    bar.appendChild(btn);
    bubble.appendChild(bar);

    // Affiche une transcription déjà en cache le cas échéant.
    const key = messageKey(audio);
    if (key) {
      try {
        const cache = await chrome.runtime.sendMessage({ type: "getCache", key });
        if (cache && cache.text) {
          showResult(bar, cache.text, false);
          btn.textContent = "✅ Transcrit";
        }
      } catch (_) {}
    }

    btn.addEventListener("click", () => transcribe(audio, bubble, btn, bar));
  }

  function scan(root) {
    const audios =
      root.tagName === "AUDIO" ? [root] : root.querySelectorAll?.("audio") || [];
    audios.forEach((a) => injectFor(a));
  }

  // --- Observation du DOM WhatsApp ----------------------------------------

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((n) => {
        if (n.nodeType === 1) scan(n);
      });
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  scan(document.body); // premier passage
})();
