/*
 * Transcription Audio WhatsApp — script injecté dans le contexte de la page
 * (content script en "world": "MAIN").
 *
 * WhatsApp contrôle lui-même l'élément <audio> : le couper depuis le content
 * script (monde isolé) arrive trop tard et un extrait sonore se fait entendre.
 *
 * Ici on patche HTMLMediaElement.play() pour forcer le silence tant que
 * l'extension est en train de récupérer l'audio (drapeau activé/désactivé par
 * postMessage depuis content.js). Le son est ainsi coupé dès la première frame,
 * sans que l'utilisateur n'entende quoi que ce soit.
 */

(() => {
  "use strict";

  let forceMute = false;

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.type === "WAT_FORCE_MUTE") forceMute = true;
    else if (event.data.type === "WAT_FORCE_UNMUTE") forceMute = false;
  });

  const proto = HTMLMediaElement.prototype;
  const originalPlay = proto.play;

  proto.play = function () {
    if (forceMute) {
      try {
        this.muted = true;
        this.volume = 0;
      } catch (_) {}
    }
    return originalPlay.apply(this, arguments);
  };
})();
