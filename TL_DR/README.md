# TL;DR — Cognitive Reading Assistant

A Chrome extension that uses webcam-based eye tracking to detect when you are struggling with text and intervenes with AI-generated summaries, read-aloud, and adaptive visual aids — automatically, without manual interaction.

---

## Table of Contents

1. [Overview](#overview)
2. [How It Works](#how-it-works)
3. [Features](#features)
4. [Cognitive States](#cognitive-states)
5. [Reader Profiles](#reader-profiles)
6. [Multilingual Support](#multilingual-support)
7. [Architecture](#architecture)
8. [File Structure](#file-structure)
9. [Installation](#installation)
10. [Running the Backend Server](#running-the-backend-server)
11. [Usage Guide](#usage-guide)
12. [Keyboard Shortcuts](#keyboard-shortcuts)
13. [Configuration](#configuration)
14. [Accessibility](#accessibility)
15. [Privacy](#privacy)
16. [Security](#security)
17. [Development Notes](#development-notes)

---

## Overview

TL;DR is a Chrome extension that watches how you read using your webcam and responds intelligently when it detects you are confused, overloaded, zoning out, or reading too quickly through difficult text. It generates AI summaries, speaks paragraphs aloud, and adapts its visual presentation — all without you lifting a finger.

The extension supports:
- Ordinary web pages (articles, documentation, Wikipedia, etc.)
- Local PDF files (`.pdf` opened from your computer)
- Local PPTX files (`.pptx` opened from your computer)

All eye-tracking computation happens locally in the browser. Only paragraph text (never gaze data or video) is sent to the AI backend.

---

## How It Works

```
Webcam → WebGazer.js (gaze estimation) → Feature Extractor → Script Patch → Classifier
                                                                                  ↓
                                                             Cognitive State (focused / skimming /
                                                             confused / zoning_out / overloaded)
                                                                                  ↓
                                                             Action: AI Summary · TTS · Nudge · nothing
```

1. **WebGazer.js** processes the webcam feed locally (TensorFlow FaceMesh) and outputs an estimated gaze point (x, y) on the screen every ~33ms. No video is recorded or transmitted.
2. **Feature extraction** computes 9 gaze features over a 2.5-second rolling window: average fixation duration, regression rate, saccade length and variance, gaze drift, velocity mean, line re-read count, and gaze quality.
3. **Personal baseline normalization** scales each feature against the user's natural reading profile (captured during reading calibration) so that a naturally fast reader and a naturally slow reader are both measured relative to themselves.
4. **Script-aware patching** adjusts features before classification based on detected page language: regression rate is inverted for RTL languages (where forward saccades go right-to-left), and fixation durations are scaled for CJK scripts (where characters require longer fixations by nature). See [Multilingual Support](#multilingual-support).
5. **The classifier** is a decision tree (exported as plain JavaScript if/else — no ML runtime needed) that maps the 9 normalized features to one of five cognitive states.
6. **State smoothing** takes the modal label across a 3-sample ring buffer to suppress single-frame noise.
7. **Actions** are dispatched based on the state: confused and overloaded fetch an AI summary and optionally trigger TTS; zoning_out shows a visual nudge; skimming and focused take no action.

---

## Features

### Core Reading Assistant
| Feature | Description |
|---|---|
| **Gaze-triggered summaries** | When confused or overloaded state persists, the AI summarises the current paragraph |
| **Text selection summaries** | Select any text with the mouse → instant AI summary popup |
| **Image / figure explanation** | Eye tracker detects confused or overloaded state while gazing at an image (2-second dwell) → AI explains what the image shows and how it connects to the surrounding text. Also triggered by `Ctrl+hover` on any `<img>` element |
| **Summary caching** | AI responses are cached for the session by `mode:fingerprint` key (max 100 entries, LRU). Re-visiting the same paragraph is instant with no extra API call |
| **Comprehension monitoring** | Detects reading too fast through dense text (Flesch-Kincaid readability) and reading too slow relative to personal baseline |
| **Scroll backtrack detection** | Detects when you scroll back to re-read, offering a summary |
| **Previous paragraph context** | The paragraph before the selected one is sent to the AI so summaries are contextually aware |
| **Save Notes** | Save any summary to a persistent notes store, viewable from the extension |

### Accuracy & Personalisation
| Feature | Description |
|---|---|
| **Dot calibration** | 9-point 3×3 grid, two passes — provides training examples for WebGazer's ridge regression |
| **Reading calibration** | Words are highlighted at natural reading speed; calibration captures ~80 training examples from actual reading positions |
| **Calibration persistence** | Calibration runs once. The offset is saved to extension storage and silently restored on every subsequent page |
| **Personal baseline** | Gaze features recorded during reading calibration become a normalisation baseline, so the classifier adapts to the individual reader |
| **Click training** | Every click on the page is recorded as a WebGazer training example, continuously improving gaze accuracy |
| **Multi-sample offset** | At calibration completion, 5 predictions at viewport centre are taken, outliers trimmed, and averaged for a stable correction offset |
| **Gaze quality gate** | When gaze quality < 25% (poor lighting, face obstructed), classification is skipped rather than guessing |
| **Gaze quality toast** | After 24 seconds of poor quality, a user-facing notification appears: "Low camera quality — move to better lighting" |
| **State smoothing** | 3-sample modal ring buffer prevents single bad frames from triggering actions |

### Visual Aids
| Feature | Description |
|---|---|
| **Dark Mode** | Toggle in the popup that themes both the extension UI and all in-page summary popups and overlays |
| **Reading Map** | Collapsible right-side sidebar showing article progress, a clickable heading minimap, and an event log of confusion / summary moments. Toggle: `Alt+M` |
| **Focus Ruler** | Dims everything above and below a ~104px horizontal band following gaze Y position. Acts as a digital reading ruler. Toggle: `Alt+F` or Assist tab |
| **Paragraph highlight** | The paragraph that triggered an action is briefly outlined |
| **Idle edge pulse** | Screen edges pulse when gaze leaves the reading area for extended periods |

### Reading Personas
Four named presets that configure all toggles at once. Select in the popup's **Reading Mode** section; settings can be further adjusted per-session.

| Persona | What it sets |
|---|---|
| **Research** | Eye tracking on · selection on · highlight on · comprehension on · focus ruler on · pin popups · idle blink on |
| **Study** | Eye tracking on · TTS on · comprehension on · autohide after 10s · idle blink on |
| **Casual** | Eye tracking off · selection only · autohide after 6s |
| **Speed** | Eye tracking on · focus ruler on · autohide after 4s · idle blink on · no comprehension check |

### Accessibility
| Feature | Description |
|---|---|
| **Dyslexia Mode** | Applies Verdana/Arial font, 2× line height, wider letter/word spacing, left alignment |
| **Colour overlay** | Optional tint (warm yellow, light blue, soft green, pale rose) rendered with `mix-blend-mode: multiply` |
| **Bionic Reading** | Bolds the first ~45% of each word to create visual anchors for each word |
| **Threshold softening** | When Dyslexia Mode is on, regression rate and fixation thresholds are patched before classification so natural dyslexic patterns do not over-trigger confused/overloaded |
| **TTS (Read Aloud)** | Web Speech API reads the triggered paragraph aloud, word by word, with each word highlighted as it is spoken. Toggle: `Alt+T` or Assist tab |

### Session Reports
| Feature | Description |
|---|---|
| **Session tracking** | Every reading session (>30s) records: time in each cognitive state, comprehension signals, average WPM, confusion/backtrack counts |
| **Session report page** | Shows: time on page, avg WPM, colour-coded state distribution bar, list of confusion moments with paragraph excerpts |
| **Highlight persistence** | Paragraphs that received an AI summary get a subtle green left border on next visit to the same URL |
| **Notes** | Summaries can be manually saved and reviewed from a dedicated notes page |

### Document Support
| Format | Mechanism |
|---|---|
| **Web pages** | Content script injects directly; gaze maps to DOM paragraphs |
| **Local PDFs** | `file://*.pdf` navigations are intercepted by the background service worker and redirected to a bundled PDF.js viewer. TL;DR content script injects normally |
| **Local PPTX** | `file://*.pptx` navigations redirected to a bundled PPTX viewer (JSZip parses slide XML). Each slide renders as a readable text card |

---

## Cognitive States

| State | What it means | Action |
|---|---|---|
| `focused` | Normal, on-task reading | None |
| `skimming` | Fast scanning, high velocity, short fixations | None |
| `confused` | High regression rate, long fixations, low saccade variance | Explain summary + optional TTS |
| `zoning_out` | Gaze drifting, low fixation count, eyes off text | Gentle visual nudge |
| `overloaded` | Unusually short fixations despite high text density | Simplified summary + optional TTS |

State is classified every 3 seconds. Actions fire with a 20-second per-paragraph cooldown to avoid feeling intrusive.

---

## Reader Profiles

### Professionals (lawyers, doctors, analysts, office workers)
Dense, long-form text is the daily norm. TL;DR helps with:
- Comprehension check flags paragraphs read faster than their difficulty warrants (critical in contracts)
- AI explains jargon in context, with the surrounding paragraph included for accuracy
- Session reports show where reading slowed down — useful for identifying clauses to re-examine
- Personal baseline adapts to their naturally fast professional reading pace, avoiding false "confused" triggers
- TTS useful for hands-free review while annotating or taking notes

### Students
- Reading calibration sets a personal WPM baseline per document type
- Confused state triggers explanations; overloaded state triggers simplifications
- PPTX viewer gives TL;DR treatment to lecture slides
- Session reports show exactly which sections they struggled with — useful for revision and identifying gaps
- Highlight persistence marks previously difficult paragraphs on re-reads
- Scroll backtrack detection recognises when they re-read a section and offers a summary
- Dyslexia Mode + bionic reading available for students who need it

### Dyslexic readers
- **Turn on Dyslexia Mode** (Accessibility tab in popup): font, spacing, and colour overlay adjust immediately
- Bionic reading bolds word anchors to reduce horizontal tracking difficulty
- Classifier thresholds are patched so the natural dyslexic reading pattern (higher regression, longer fixations) does not over-trigger confused/overloaded — the extension understands this is normal
- TTS as a parallel channel: the text is both visible and spoken
- Focus Ruler eliminates the common "losing my place on the line" problem
- Because Dyslexia Mode is self-declared (toggle), there are no false-positive detection issues

### Non-native speakers / language learners
- AI responses are generated **in the same language as the text being read** — explanations of a French article come in French, Arabic in Arabic, Japanese in Japanese
- RTL language support: the gaze classifier is adapted automatically for Arabic, Hebrew, Persian, and other RTL scripts (see [Multilingual Support](#multilingual-support))
- TTS helps with pronunciation and prosody
- Backtrack detection recognises when a sentence needed a second read
- Selection summary works on any highlighted phrase
- Consider combining with Dyslexia Mode's wider spacing, which also helps when reading in a second language

### Casual / general readers
- Everything is automatic once the camera is on — no manual interaction required
- Idle edge pulse is a gentle reminder to re-engage when zoning out
- Session reports show how long sessions actually were vs how much was active reading
- Autohide popups keep the experience clean

### Researchers / academics
- FK readability scoring is calibrated to academic difficulty levels
- Very difficult paragraphs (FK score < 40) trigger a different expected WPM threshold
- Personal baseline normalises to the researcher's own pace with dense literature
- Previous paragraph context means AI summaries understand the argument structure

---

## Multilingual Support

### AI response language
All server prompts instruct the model to respond in the same language as the passage being read. An Arabic paragraph produces an Arabic summary; a Japanese paragraph produces Japanese. This requires no user configuration.

### RTL languages (Arabic, Hebrew, Persian, Urdu, and others)

The gaze classifier was trained on left-to-right English reading data. In LTR reading, a leftward eye movement (dx < 0) is a regression — going back to re-read. In RTL reading, leftward is *forward*. Without adaptation, a focused Arabic reader would generate a very high raw regression rate (~0.7) and be falsely classified as confused or overloaded.

`lang-detect.js` detects RTL pages and inverts the `regression_rate` feature before classification:

```
patched_regression_rate = 1 − raw_regression_rate
```

This inversion is symmetric: it correctly maps both states.

| Reader state | Raw regression rate | After inversion | Classifier output |
|---|---|---|---|
| Focused RTL reader (mostly leftward saccades) | ~0.70 | ~0.30 | focused ✓ |
| Confused RTL reader (re-reading rightward) | ~0.30 | ~0.70 | confused ✓ |

A confused RTL reader produces *fewer* forward (leftward) saccades because they are re-reading sections rightward — so their raw rate drops, the inversion pushes it high, and the classifier correctly fires. The distress signal is preserved, not erased.

### CJK languages (Chinese, Japanese, Korean)

CJK character-based scripts require longer fixation durations per unit of text — typically 30–40% above alphabetic baselines, because each glyph is semantically dense. The trained classifier threshold for confusion is 450 ms average fixation. A focused Japanese reader processing complex kanji at 450–500 ms would cross that threshold and be falsely classified as confused.

`lang-detect.js` scales fixation features by 0.78 on CJK pages:

```
avg_fixation_ms  ← avg_fixation_ms × 0.78
fixation_std     ← fixation_std     × 0.78
```

A 500 ms normal-but-dense fixation becomes 390 ms — safely in the focused zone. A genuinely confused fixation at 650 ms becomes 507 ms — still above threshold, correctly triggering an explanation.

The Flesch-Kincaid readability check (in `comprehension-monitor.js`) is already bypassed on non-English pages via an `isEnglishPage()` guard, so CJK readers are not penalised by an English-only formula.

### Script detection (`lang-detect.js`)

Detection runs once on page load using three layers:

1. `<html lang="...">` attribute — most reliable when set correctly
2. `dir="rtl"` HTML attribute or CSS `direction: rtl` computed style — catches sites that set direction without a proper lang tag
3. Unicode character sampling — reads the first 1000 visible characters of `body.innerText` and checks what fraction fall in RTL Unicode blocks (Arabic U+0600–06FF, Hebrew U+0590–05FF, etc.) or CJK blocks (Hiragana, Katakana, CJK Unified U+4E00–9FFF, Hangul). If >15% of non-whitespace characters match, the script is detected.

The 15% threshold avoids false positives from pages that embed a few foreign words in otherwise Latin-script text.

Summary popups use `dir="auto"` on their content area, so the browser's bidi algorithm automatically renders RTL AI responses in the correct direction without explicit tracking.

**Known limitation:** detection runs once per page load. Single-page apps that navigate between language contexts without a full reload will not re-detect. A `MutationObserver` on the `<html>` element's `lang`/`dir` attributes would address this in a future update.

---

## Architecture

```
TL_DR/
├── manifest.json              MV3 extension manifest
├── background.js              Service worker: message routing, file:// intercept, tab management
│
├── src/
│   ├── content/
│   │   ├── content.js         Main content script: orchestrates all modules
│   │   ├── classifier.js      Decision tree: 9 features → 5 cognitive states
│   │   ├── gaze-utils.js      EMA smoothing, velocity rejection, calibration, baseline normalisation
│   │   ├── gaze-features.js   Rolling window feature extractor (DBSCAN noise filter)
│   │   ├── lang-detect.js     Script detection (RTL/CJK) and pre-classification feature patching
│   │   ├── comprehension-monitor.js  WPM measurement, too-fast/too-slow detection, backtrack
│   │   ├── reading-calibration.js    Word-by-word expert calibration overlay
│   │   ├── session-tracker.js        Per-session state durations, signals, WPM, persistence
│   │   ├── tts-handler.js     Web Speech API: sentence splitting, word-boundary highlighting
│   │   ├── focus-ruler.js     Horizontal dim-band following gaze Y
│   │   ├── dyslexia-utils.js  Font/spacing CSS, colour overlay, bionic reading, threshold patch
│   │   ├── reading-map.js     Collapsible sidebar: progress bar, heading minimap, event log
│   │   ├── idle-overlay.js    Edge pulse when gaze leaves screen
│   │   ├── overlay-utils.js   DOM block ancestor finder, popup positioning helpers
│   │   ├── pdf-handler.js     PDF text extraction helpers
│   │   ├── pptx-handler.js    PPTX parsing via JSZip
│   │   ├── sra-page-bridge.js Bridge between isolated content-script world and page context
│   │   └── webgazer-bootstrap.js  Loads WebGazer in MAIN world, pipes gaze via postMessage
│   │
│   ├── popup/
│   │   ├── popup.html         Three-tab popup: Assist · Accessibility · Session
│   │   ├── popup.js           Popup logic: settings, broadcast, camera status, simulate, personas
│   │   ├── session-report.html  Per-session reading report with state distribution chart
│   │   └── notes.html         Saved notes viewer
│   │
│   ├── pdf-viewer/
│   │   └── viewer.html        Extension-hosted PDF viewer (PDF.js); content script injects here
│   │
│   ├── pptx-viewer/
│   │   └── viewer.html        Extension-hosted PPTX viewer (JSZip); content script injects here
│   │
│   ├── libs/
│   │   ├── webgazer.min.js    Bundled WebGazer (TF FaceMesh + ridge regression)
│   │   ├── jszip.min.js       Bundled JSZip (PPTX parsing)
│   │   └── pdfjs/
│   │       ├── pdf.min.js     Bundled PDF.js
│   │       └── pdf.worker.min.js
│   │
│   └── styles/
│       └── overlay.css        Popup, calibration, highlight, nudge styles
│
└── server/
    ├── index.js               Express proxy to Groq API
    └── .env                   GROQ_API_KEY (not committed)
```

### Cross-world communication

Chrome extensions run content scripts in an isolated JavaScript world. `window.webgazer` is not accessible from there. TL;DR solves this with a postMessage bridge:

```
Content script (isolated world)
    ↓ postMessage({ source: 'sra-cal-record', x, y })
webgazer-bootstrap.js (MAIN world)
    ↓ webgazer.recordScreenPosition(x, y)
    ↓ postMessage({ source: 'sra-webgazer', gaze: {x, y} })
Content script
    ↓ onGaze(data) → feature extraction → script patch → classification
```

---

## File Structure

See the Architecture section above for the annotated tree. Key relationships:

- `content.js` imports all other content modules via `import(chrome.runtime.getURL(...))` (dynamic ES module imports)
- `background.js` handles `file://` interception and message routing (tab creation, note saving, WebGazer injection fallback)
- The popup communicates with the content script via `chrome.tabs.sendMessage` and `chrome.storage`

---

## Installation

### Prerequisites
- Google Chrome (or Chromium-based browser)
- Node.js 18+ (for the backend server)
- A Groq API key (free tier available at console.groq.com)
- A webcam

### Load the extension

1. Clone or download this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top right toggle).
4. Click **Load unpacked** and select the `TL_DR/` folder (the one containing `manifest.json`).

### Allow file access (for PDF and PPTX support)

1. On `chrome://extensions`, click **Details** next to TL;DR.
2. Enable **Allow access to file URLs**.

This is required for the PDF and PPTX viewers to fetch local files.

---

## Running the Backend Server

The extension requires a local backend that proxies requests to the Groq API.

```bash
cd TL_DR/server
npm install
```

Create a `.env` file in the `server/` directory:

```
GROQ_API_KEY=gsk_your_key_here
```

Start the server:

```bash
node index.js
```

The server listens on `http://localhost:3000` by default. It exposes one endpoint:

```
POST /api/summarize
Content-Type: application/json

{
  "text": "paragraph text...",
  "mode": "tldr" | "explain_more" | "simplify" | "explain_code" | "image_context",
  "context": "previous paragraph text (optional)"
}
```

**Security:** CORS is restricted to `localhost` and `chrome-extension://` origins only. A rate limiter of 30 requests per minute per IP is applied. The `GROQ_API_KEY` is never exposed to the extension.

---

## Usage Guide

### First use

1. Navigate to any page with text.
2. Open the extension popup (click the TL;DR icon).
3. Go to the **Session** tab → click **Start Camera** → allow camera access.
4. A dot-calibration overlay appears. Click each green dot as it appears (two passes, 18 clicks total).
5. The calibration is saved. It will not appear again on future pages.

### Optional: reading calibration (recommended)

In the **Session** tab, click **Reading Calibration**. A paragraph is shown with words highlighted one at a time. Read at your natural pace — no clicking needed. This captures ~80 training points from your actual reading zone and builds your personal WPM baseline.

**Run reading calibration once. Run dot calibration once. Both persist across all future pages.**

### Reading personas

In the popup's **Reading Mode** section, click a persona button (**Research**, **Study**, **Casual**, or **Speed**) to apply a preset configuration instantly. You can still adjust individual toggles after applying a persona.

### Day-to-day

Once camera is on, the extension runs silently. It will:
- Show an AI popup when it detects confusion or overload
- Explain images you gaze at while confused (2-second dwell triggers automatically)
- Offer a summary when you read through a dense paragraph too quickly
- Offer a summary when you scroll back up to re-read

You can also:
- **Select any text** → instant summary appears
- **`Ctrl+hover` over any image** → instant image explanation
- **Press `Alt+S`** → summarise the paragraph at gaze/viewport centre
- **Press `Alt+T`** → toggle read-aloud
- **Press `Alt+F`** → toggle focus ruler
- **Press `Alt+M`** → toggle reading map sidebar
- **Press `Esc`** → close any open popup

### Viewing your session report

After reading, open the popup → **Session** tab → **Session Report**. Sessions shorter than 30 seconds are not saved.

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Alt+S` | Summarise paragraph at current gaze / viewport centre |
| `Alt+T` | Toggle Read Aloud (TTS) on/off |
| `Alt+F` | Toggle Focus Ruler on/off |
| `Alt+M` | Toggle Reading Map sidebar |
| `Alt+N` | Open Saved Notes page |
| `Alt+G` | Open Session Report page |
| `Esc` | Close the active summary popup |
| `Alt+1` | Simulate: Confused state (for testing) |
| `Alt+2` | Simulate: Overloaded state |
| `Alt+3` | Simulate: Zoning Out state |
| `Alt+4` | Simulate: Skimming state |

All shortcuts are listed in the **Session** tab of the popup for discoverability.

---

## Configuration

All settings are stored in `chrome.storage.local` and survive browser restarts.

| Storage key | Default | Description |
|---|---|---|
| `sra_enabled` | `true` | Master on/off |
| `sra_eye` | `true` | Eye tracking on/off |
| `sra_selection` | `true` | Text-selection summaries |
| `sra_highlight_para` | `true` | Highlight source paragraph |
| `sra_autohide` | `false` | Auto-dismiss popups |
| `sra_autohide_timeout` | `12` | Auto-dismiss delay (seconds) |
| `sra_pin_default` | `false` | Pin popups open by default |
| `sra_debug` | `false` | Show gaze prediction dots |
| `sra_idle_blink` | `true` | Edge pulse when zoning out |
| `sra_comprehension` | `true` | Comprehension speed checks |
| `sra_tts` | `false` | Read Aloud on confusion |
| `sra_focus_ruler` | `false` | Focus ruler (dim band) |
| `sra_dyslexia` | `false` | Dyslexia mode |
| `sra_dyslexia_color` | `rgba(255,243,180,0.12)` | Colour overlay tint |
| `sra_bionic` | `false` | Bionic reading |
| `sra_dark_mode` | `false` | Dark mode for extension UI and in-page popups |
| `sra_active_persona` | `''` | Last applied reading persona (`research` / `study` / `casual` / `speed`) |
| `sra_backend_url` | `http://localhost:3000/api/summarize` | AI backend endpoint |
| `sra_ever_calibrated` | `false` | Whether dot calibration has run |
| `sra_calibration` | `{dx:0, dy:0}` | Gaze correction offset |
| `sra_personal_baseline` | `null` | Personal gaze feature baseline |
| `sra_baseline_wpm` | `null` | Personal WPM baseline |
| `sra_current_state` | `''` | Last classified cognitive state |
| `sra_camera_ready` | `false` | Camera initialisation status |
| `sra_notes` | `[]` | Saved notes array |
| `sra_sessions` | `[]` | Session report data (last 20) |
| `sra_highlights` | `{}` | Paragraph highlights by URL key |

---

## Accessibility

### Dyslexia Mode
Activated via the **Accessibility** tab in the popup (self-declaration). Applies:
- Font: Verdana/Arial (high legibility, wider letterforms)
- Line height: 2.0 (reduces line crowding)
- Letter spacing: +0.06em
- Word spacing: +0.14em
- Text alignment: left (ragged right reduces river patterns)
- Optional colour overlay (warm yellow default) with `mix-blend-mode: multiply`

### Bionic Reading
When enabled (sub-option under Dyslexia Mode), the first 45% of each word is bolded to provide a visual anchor. Applied to paragraphs when an AI action fires.

### Focus Ruler
A soft horizontal dim-band follows gaze Y position in real time. Keeps the eye anchored to the current reading line. Especially effective for:
- Readers who lose their place mid-line
- Dense multi-column layouts
- Long lines without natural breaks

**The focus ruler is optional.** Toggle with `Alt+F` or the **Focus Ruler** toggle in the Assist tab. It is off by default.

### TTS (Text-to-Speech)
Uses the Web Speech API (browser-native, no external dependencies, works offline). When the confused state is detected and TTS is on, the paragraph is spoken sentence-by-sentence with each word highlighted as it is spoken.

Toggle with `Alt+T` or the **Read Aloud** toggle in the Assist tab.

### Dark Mode
Toggle in the popup header. Themes the popup UI and all in-page overlays (summary popups, reading map, calibration panel, page summary panel). Preference is saved across sessions.

---

## Privacy

- **No video is recorded, stored, or transmitted.** WebGazer processes webcam frames locally using TensorFlow.js and discards them immediately after extracting facial landmarks.
- **Only paragraph text is sent to the AI backend.** Gaze coordinates, feature values, cognitive state labels, and all session data remain local.
- **The AI backend runs locally** (`localhost:3000`). Paragraph text leaves your machine only to reach `localhost` (which then calls Groq). If you run your own Groq-compatible endpoint, no text leaves your machine at all.
- **Session reports, highlights, and notes** are stored in `chrome.storage.local` — local to your browser profile, never synced to a server.

---

## Security

| Control | Implementation |
|---|---|
| CORS restriction | Backend only accepts requests from `chrome-extension://` and `localhost` origins |
| Rate limiting | 30 requests per minute per IP on `/api/summarize` |
| Secret isolation | `GROQ_API_KEY` lives in `server/.env` only, never in extension files |
| `.gitignore` | `.env` is excluded from version control |
| No remote code | All libraries (WebGazer, PDF.js, JSZip) are bundled locally; no CDN calls from the extension |
| Input sanitisation | All text rendered in popups is HTML-escaped before insertion |

---

## Development Notes

### Adding a new cognitive state

1. Add the label to the classifier tree in `src/content/classifier.js`.
2. Add a corresponding entry in `COGNITIVE_STATE_ACTIONS` in the same file.
3. Add a chip and colour in `popup.html` and `overlay.css`.

### Changing the AI model

Edit `server/index.js` — update the `model` field in the Groq API call. The extension is model-agnostic.

### Retraining the classifier

The current classifier is a static decision tree generated from synthetic training data. To retrain:
1. Collect labelled `(features, state)` pairs from real sessions (session-tracker.js can be extended to export raw feature vectors)
2. Train a decision tree (scikit-learn works well)
3. Export as JavaScript if/else and replace `src/content/classifier.js`

Note: if retraining with multilingual data, include RTL and CJK reading samples and remove the script-aware patching in `lang-detect.js` — the patching is only needed because the current classifier was trained on LTR alphabetic data.

### Adding a new reading persona

In `popup.js`, add a key to the `PERSONAS` constant with the desired toggle values, then add a corresponding `<button class="persona-btn" data-persona="...">` in `popup.html`.

### Extension permissions explained

| Permission | Reason |
|---|---|
| `storage` | Save settings, calibration, notes, sessions |
| `scripting` | Inject WebGazer into page context (MAIN world) |
| `activeTab` | Communicate with the current tab |
| `tabs` | Read tab URL for file:// interception; create new tabs |
| `webNavigation` | Monitor navigation for file:// redirect |
| `file:///*` | Fetch local PDF/PPTX files in the viewer pages |

---

## Upcoming

- **Domain-specific calibration** — separate WPM baselines per content type (news, academic, technical)
- **Multilingual classifier retraining** — collect RTL and CJK reading data to train a natively multilingual decision tree, removing the need for the current feature-patching workaround
- **SPA language re-detection** — `MutationObserver` on `<html lang>` / `dir` to re-run script detection when single-page apps navigate between language contexts without a full page reload
- **Collaborative / classroom mode** — lecturer creates a room; students' confusion events are aggregated in real time; lecturer sees a heatmap of which sections the class struggled with (architecture in progress)
- **Session export** — export session reports as JSON or formatted text for teacher review
- **PPTX image slides** — current viewer renders text-only slides; image-heavy slides show as empty

---

*Built by CJ_ · Powered by WebGazer.js, PDF.js, JSZip, Groq (llama-3.1-8b-instant / llama-3.3-70b-versatile)*
