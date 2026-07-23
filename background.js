/*
 * Transcription Audio WhatsApp — service worker (MV3)
 *
 * Reçoit l'audio depuis le content script, appelle l'API Whisper
 * (OpenAI ou Groq) et renvoie le texte. Les appels réseau se font ici
 * afin de contourner les restrictions CORS (grâce à host_permissions).
 */

"use strict";

const PROVIDERS = {
  openai: {
    endpoint: "https://api.openai.com/v1/audio/transcriptions",
    model: "whisper-1",
  },
  groq: {
    endpoint: "https://api.groq.com/openai/v1/audio/transcriptions",
    model: "whisper-large-v3-turbo",
  },
};

const CACHE_PREFIX = "wat_cache_";
const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 jours

function base64ToBlob(base64, mime) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function getSettings() {
  const { provider, apiKey, language } = await chrome.storage.local.get([
    "provider",
    "apiKey",
    "language",
  ]);
  return {
    provider: provider || "groq",
    apiKey: apiKey || "",
    language: language || "fr",
  };
}

async function readCache(key) {
  if (!key) return null;
  const storeKey = CACHE_PREFIX + key;
  const data = await chrome.storage.local.get(storeKey);
  const entry = data[storeKey];
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    chrome.storage.local.remove(storeKey);
    return null;
  }
  return entry;
}

async function writeCache(key, text) {
  if (!key) return;
  await chrome.storage.local.set({
    [CACHE_PREFIX + key]: { text, ts: Date.now() },
  });
}

async function callWhisper({ audioBase64, mime, key }) {
  const cached = await readCache(key);
  if (cached) return { ok: true, text: cached.text, cached: true };

  const { provider, apiKey, language } = await getSettings();
  const cfg = PROVIDERS[provider] || PROVIDERS.groq;

  if (!apiKey) {
    return {
      ok: false,
      error:
        "Clé API manquante. Cliquez sur l'icône de l'extension pour la configurer.",
    };
  }

  const ext = mime.includes("ogg")
    ? "ogg"
    : mime.includes("mpeg") || mime.includes("mp3")
    ? "mp3"
    : mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")
    ? "m4a"
    : mime.includes("wav")
    ? "wav"
    : "webm";

  const blob = base64ToBlob(audioBase64, mime);
  const form = new FormData();
  form.append("file", blob, `audio.${ext}`);
  form.append("model", cfg.model);
  form.append("language", language);
  form.append("response_format", "json");

  let resp;
  try {
    resp = await fetch(cfg.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch (e) {
    return { ok: false, error: "Erreur réseau : " + e.message };
  }

  if (!resp.ok) {
    let detail = "";
    try {
      const j = await resp.json();
      detail = j.error?.message || JSON.stringify(j);
    } catch (_) {
      detail = await resp.text().catch(() => "");
    }
    return { ok: false, error: `API ${resp.status} : ${detail}` };
  }

  const data = await resp.json();
  const text = (data.text || "").trim();
  await writeCache(key, text);
  return { ok: true, text };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "transcribe") {
    callWhisper(msg).then(sendResponse);
    return true; // réponse asynchrone
  }
  if (msg?.type === "getCache") {
    readCache(msg.key).then((entry) => sendResponse(entry || null));
    return true;
  }
});
