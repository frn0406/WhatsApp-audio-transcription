# 🎙️ Transcription Audio WhatsApp

Extension Chrome **légère** (Manifest V3, sans dépendance ni build) qui ajoute un bouton
**Transcrire** sous chaque message vocal de [WhatsApp Web](https://web.whatsapp.com) et
affiche la transcription en texte — optimisée pour le **français**.

La transcription utilise l'API **Whisper**, au choix :

| Fournisseur | Modèle | Remarque |
|-------------|--------|----------|
| **Groq** (défaut) | `whisper-large-v3-turbo` | Très rapide, offre gratuite généreuse |
| **OpenAI** | `whisper-1` | Payant à l'usage |

L'audio est envoyé au fournisseur choisi **uniquement au moment où vous cliquez** sur
« Transcrire ». Rien n'est transmis automatiquement.

---

## Installation (mode développeur)

1. Téléchargez / clonez ce dossier `whatsapp-audio-transcriber/`.
2. Ouvrez `chrome://extensions` dans Chrome (ou Edge/Brave).
3. Activez le **Mode développeur** (en haut à droite).
4. Cliquez sur **Charger l'extension non empaquetée** et sélectionnez le dossier
   `whatsapp-audio-transcriber/`.
5. Cliquez sur l'icône de l'extension → renseignez votre **fournisseur** et votre **clé API** :
   - Groq (gratuit) : https://console.groq.com/keys
   - OpenAI : https://platform.openai.com/api-keys
6. Ouvrez https://web.whatsapp.com et cliquez sur **🎙️ Transcrire** sous un vocal.

---

## Comment ça marche

```
WhatsApp Web ──(blob audio)──▶ content.js ──(base64)──▶ background.js ──(HTTPS)──▶ API Whisper
     ▲                                                                                  │
     └──────────────────── texte affiché sous le message ◀───────────────────────────┘
```

- **`content.js`** — observe le DOM, injecte le bouton, récupère le blob audio du vocal
  (déclenche la lecture si nécessaire pour forcer le chargement), l'encode en base64.
- **`background.js`** — service worker : construit le `FormData`, appelle l'API Whisper
  (les appels réseau sont faits ici pour contourner CORS via `host_permissions`),
  met en cache le résultat (`chrome.storage.local`, 3 jours).
- **`popup.html/js`** — configuration du fournisseur, de la clé API et de la langue.

## Confidentialité

- La clé API est stockée **localement** (`chrome.storage.local`), jamais transmise ailleurs
  qu'au fournisseur choisi.
- L'audio n'est envoyé qu'au fournisseur sélectionné, et seulement sur clic.
- Aucune donnée n'est envoyée à un serveur tiers de l'auteur.

## Fichiers

| Fichier | Rôle |
|---------|------|
| `manifest.json` | Déclaration de l'extension (MV3) |
| `content.js` / `content.css` | Injection UI + extraction de l'audio |
| `background.js` | Appel API Whisper + cache |
| `popup.html` / `popup.js` | Écran de configuration |

## Détection des vocaux

WhatsApp Web n'insère plus de balise `<audio>` par message tant que le vocal n'est pas lu.
L'extension s'ancre donc sur des éléments toujours présents : le curseur de lecture
`[role="slider"][aria-valuetext]` et le bouton play `[data-icon="audio-play"]` (ou `ptt-play`).
Le blob audio n'est récupéré qu'au clic, en déclenchant brièvement la lecture (le son est
coupé automatiquement) puis en mettant en pause.

## Limites connues

- WhatsApp Web change régulièrement son DOM ; si le bouton n'apparaît plus, les sélecteurs
  de `content.js` (`[role="slider"][aria-valuetext]`, `data-icon="audio-play"`, `.message-in/.message-out`)
  devront être mis à jour.
- Un très court extrait sonore peut se faire entendre au tout début de la récupération, avant
  la coupure automatique du son.
- Taille max d'un fichier audio : 25 Mo (limite Whisper) — sans objet pour des vocaux normaux.
