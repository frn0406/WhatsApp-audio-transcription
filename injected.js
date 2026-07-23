/*
 * Transcription Audio WhatsApp — script injecté dans le contexte de la page.
 *
 * Deux rôles :
 *
 * 1. Silence forcé : patch de HTMLMediaElement.play() pour couper le son dès
 *    la première frame pendant que l'extension récupère l'audio (drapeau
 *    activé/désactivé par postMessage depuis content.js).
 *
 * 2. Capture des médias : WhatsApp lit les vocaux soit via un Blob complet,
 *    soit via un flux MediaSource (non téléchargeable par fetch, fréquent sur
 *    les longs messages). On hooke URL.createObjectURL pour mémoriser les
 *    Blobs/MediaSources créés, et SourceBuffer.appendBuffer pour copier les
 *    octets exacts injectés dans le lecteur. content.js les récupère ensuite
 *    par postMessage — aucune écoute nécessaire.
 */

(() => {
  "use strict";

  // --- 1. Silence forcé ----------------------------------------------------

  let forceMute = false;

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

  // --- 2. Capture des médias ----------------------------------------------

  const blobByUrl = new Map(); // url -> Blob (garde le Blob vivant même révoqué)
  const msByUrl = new Map(); // url -> MediaSource
  const msData = new WeakMap(); // MediaSource -> { chunks: ArrayBuffer[], mime }

  const originalCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = originalCreateObjectURL.call(URL, obj);
    try {
      if (typeof MediaSource !== "undefined" && obj instanceof MediaSource) {
        msByUrl.set(url, obj);
      } else if (obj instanceof Blob) {
        blobByUrl.set(url, obj);
      }
    } catch (_) {}
    return url;
  };

  if (typeof MediaSource !== "undefined") {
    const originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (mime) {
      const sb = originalAddSourceBuffer.call(this, mime);
      let rec = msData.get(this);
      if (!rec) {
        rec = { chunks: [], mime };
        msData.set(this, rec);
      }
      rec.mime = mime;

      const originalAppend = sb.appendBuffer.bind(sb);
      sb.appendBuffer = function (data) {
        try {
          const copy =
            data instanceof ArrayBuffer
              ? data.slice(0)
              : data.buffer.slice(
                  data.byteOffset,
                  data.byteOffset + data.byteLength
                );
          rec.chunks.push(copy);
        } catch (_) {}
        return originalAppend(data);
      };
      return sb;
    };
  }

  function concatChunks(chunks) {
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(new Uint8Array(c), offset);
      offset += c.byteLength;
    }
    return out.buffer;
  }

  // --- Dialogue avec content.js -------------------------------------------

  window.addEventListener("message", async (event) => {
    if (event.source !== window || !event.data) return;
    const msg = event.data;

    if (msg.type === "WAT_FORCE_MUTE") {
      forceMute = true;
      return;
    }
    if (msg.type === "WAT_FORCE_UNMUTE") {
      forceMute = false;
      return;
    }
    if (msg.type !== "WAT_GET_MEDIA") return;

    const reply = (payload, transfer) =>
      window.postMessage(
        Object.assign({ type: "WAT_MEDIA", id: msg.id }, payload),
        "*",
        transfer || []
      );

    try {
      const url = msg.url;

      // Cas Blob complet.
      const blob = blobByUrl.get(url);
      if (blob) {
        if (msg.sizeOnly) {
          reply({ ok: true, kind: "blob", size: blob.size, ended: true });
          return;
        }
        const buffer = await blob.arrayBuffer();
        reply(
          { ok: true, kind: "blob", mime: blob.type, ended: true, buffer },
          [buffer]
        );
        return;
      }

      // Cas MediaSource : octets copiés au fil des appendBuffer.
      const ms = msByUrl.get(url);
      const rec = ms && msData.get(ms);
      if (rec && rec.chunks.length) {
        const ended = ms.readyState === "ended";
        if (msg.sizeOnly) {
          const size = rec.chunks.reduce((n, c) => n + c.byteLength, 0);
          reply({ ok: true, kind: "mse", size, ended });
          return;
        }
        const buffer = concatChunks(rec.chunks);
        reply({ ok: true, kind: "mse", mime: rec.mime, ended, buffer }, [
          buffer,
        ]);
        return;
      }

      reply({ ok: false, error: "not-found" });
    } catch (e) {
      reply({ ok: false, error: String((e && e.message) || e) });
    }
  });
})();
