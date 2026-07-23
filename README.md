# 🎙️ Transcription Audio WhatsApp

Extension Chrome **légère** (Manifest V3, sans dépendance ni build) qui ajoute un bouton
**Transcrire** sous chaque message vocal de [WhatsApp Web](https://web.whatsapp.com) et
affiche la transcription en texte — optimisée pour le **français**.

La transcription utilise l'API **Whisper**, au choix :

| Fournisseur | Transcription | Résumé | Remarque |
|-------------|---------------|--------|----------|
| **Groq** (défaut) | `whisper-large-v3-turbo` | `llama-3.3-70b-versatile` | Très rapide, offre gratuite généreuse |
| **OpenAI** | `whisper-1` | `gpt-4o-mini` | Payant à l'usage |

Après transcription, un bouton **📝 Résumer** synthétise le message en quelques puces
(informations, demandes, dates, décisions) — pratique pour les longs vocaux. Même clé API,
résumé mis en cache comme la transcription.

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

- **`injected.js`** — script exécuté dans le contexte de la page (`world: MAIN`).
  Patche `HTMLMediaElement.play()` pour **forcer le mode muet** pendant la récupération :
  aucun son n'est joué à l'utilisateur.
- **`content.js`** — observe le DOM, injecte le bouton, déclenche silencieusement la lecture
  pour forcer le chargement du blob, l'encode en base64, puis remet aussitôt en pause.
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
| `injected.js` | Force le mode muet pendant la récupération (contexte page) |
| `content.js` / `content.css` | Injection UI + extraction de l'audio |
| `background.js` | Appel API Whisper + cache |
| `popup.html` / `popup.js` | Écran de configuration |

## Détection des vocaux

WhatsApp Web n'insère plus de balise `<audio>` par message tant que le vocal n'est pas lu.
L'extension s'ancre donc sur des éléments toujours présents : le curseur de lecture
`[role="slider"][aria-valuetext]` et le bouton play `[data-icon="audio-play"]` (ou `ptt-play`).

Le blob audio n'est récupéré qu'au clic. La lecture est déclenchée **en mode muet forcé**
(`injected.js` coupe le son dès le premier `play()`), le fichier complet étant disponible dès
le début de la lecture : **inutile d'écouter le message en entier**. La lecture est mise en
pause immédiatement après récupération. L'utilisateur n'entend rien.

## Limites connues

- WhatsApp Web change régulièrement son DOM ; si le bouton n'apparaît plus, les sélecteurs
  de `content.js` (`[role="slider"][aria-valuetext]`, `data-icon="audio-play"`, `.message-in/.message-out`)
  devront être mis à jour.
- Taille max d'un fichier audio : 25 Mo (limite Whisper) — sans objet pour des vocaux normaux.
