/* Transcription Audio WhatsApp — logique du popup de configuration */

"use strict";

const $ = (id) => document.getElementById(id);

const KEY_HINTS = {
  groq: 'Obtenez une clé gratuite sur <a href="https://console.groq.com/keys" target="_blank">console.groq.com</a>.',
  openai:
    'Créez une clé sur <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com</a>.',
};

function refreshHint() {
  $("keyHint").innerHTML = KEY_HINTS[$("provider").value] || "";
}

async function load() {
  const { provider, apiKey, language } = await chrome.storage.local.get([
    "provider",
    "apiKey",
    "language",
  ]);
  $("provider").value = provider || "groq";
  $("apiKey").value = apiKey || "";
  $("language").value = language || "fr";
  refreshHint();
}

async function save() {
  const provider = $("provider").value;
  const apiKey = $("apiKey").value.trim();
  const language = ($("language").value.trim() || "fr").toLowerCase();

  await chrome.storage.local.set({ provider, apiKey, language });

  const status = $("status");
  status.textContent = "✅ Enregistré !";
  setTimeout(() => (status.textContent = ""), 2000);
}

$("provider").addEventListener("change", refreshHint);
$("save").addEventListener("click", save);
document.addEventListener("DOMContentLoaded", load);
