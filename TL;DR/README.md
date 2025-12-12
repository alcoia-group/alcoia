# TL;DR - Smart Reading Assistant — MVP

Lightweight Chrome extension that uses in-browser eye-tracking (WebGazer) and an online AI backend to provide TL;DR summaries of paragraphs the user lingers on, and quick summaries for text selections.

## What's included

- `manifest.json` — Extension manifest (MV3).
- `background.js` — Service worker to save notes.
- `src/content/content.js` — Content script: injects WebGazer, maps gaze to paragraphs/text, triggers backend summarization and shows floating frosted-popups.
- `src/popup/*` — Toolbar popup UI to toggle features and set backend URL.
- `server/` — Node/Express sample AI backend proxy (`/api/summarize`).

## Colors & UI

- Cream background, dark gray text, dark green primary buttons, soft blue secondary, gold accent for upgrade.
- Popups use frosted glass via CSS `backdrop-filter: blur()` and slight translucency.

## Running the backend

1. Open terminal in the `server/` folder.
2. Install dependencies: `npm install`.
3. Set your OpenAI API key and start the server:

```powershell
$env:OPENAI_API_KEY = 'sk-...'
npm start
```

The backend listens on `http://localhost:3000` by default.

## Loading the extension in Chrome (development)

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked" and select the project root folder (the folder that contains `manifest.json`).
4. Open a page with text or a PDF and allow camera access if prompted (WebGazer needs the webcam).

## Notes, limitations, and next steps

- This MVP loads WebGazer from a third-party CDN. For production, bundle or vendor the library.
- Camera permission is requested by the page when WebGazer calls `getUserMedia`; some sites may block or redirect.
- PDF.js integration: this MVP maps text via DOM text nodes and `textLayer` if present; full PDF.js bundling may improve reliability.
- Add authentication, rate-limiting, and caching in the backend for production.
- Add notes dashboard UI and persistent sync.

## How the content script decides to show summaries

- WebGazer provides gaze x/y in page coordinates; the script determines the block-level ancestor of the element at that point. If gaze remains on the same block for >1.5 seconds, it sends the block text to the backend to generate a TL;DR and shows a floating popup.
- Text selection (mouseup) triggers an immediate TL;DR for selected text.

## Files to tweak for your environment

- `server/index.js` — set `OPENAI_API_KEY` environment variable.
- `src/popup/popup.js` — backend URL defaults can be changed.

If you want, I can add (next steps): a notes dashboard UI, PDF.js bundling and improved paragraph segmentation, calibration UI for eye-tracking, or tests around the backend.
