<p align="center">
  <img src="assets/alcoia-wordmark-cream.png" width="460" alt="alcoia">
</p>

<p align="center"><em>reference</em></p>

---

A browser extension that notices when reading slows down on a page and offers help with that
passage. Detection runs on **browser reading signals**: pace against text difficulty and against your
own baseline, re-reading, selection, tab focus, which needs no permission and no camera. There is
no webcam mode: it has been removed, not merely demoted, and no `getUserMedia` call exists anywhere
in the shipped code.

The primary intervention is a **question about what you just read**, not a summary: an answer is
the only ground truth in the system, and summarising performs the work retrieval would otherwise
do. A correct answer ends the interaction with confirmation only; an explanation appears only after
a wrong one.

This file is the extension's own reference: feature list, configuration, keyboard shortcuts. For
product intent, invariants and repository layout, see [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).
The top-level [`../README.md`](../README.md) covers the product pitch, privacy and licensing.

---

## Table of Contents

1. [Overview](#overview)
2. [How It Works](#how-it-works)
3. [Features](#features)
4. [Reading States](#reading-states)
5. [Reader Profiles](#reader-profiles)
6. [Multilingual Support](#multilingual-support)
7. [Architecture](#architecture)
8. [Installation](#installation)
9. [Running the Backend Server](#running-the-backend-server)
10. [Usage Guide](#usage-guide)
11. [Keyboard Shortcuts](#keyboard-shortcuts)
12. [Configuration](#configuration)
13. [Accessibility](#accessibility)
14. [Privacy](#privacy)
15. [Security](#security)
16. [Development Notes](#development-notes)

---

## Overview

alcoia watches how you read (pace against text difficulty and your own baseline, re-reading,
selection, tab focus) using only browser reading signals, no camera, and asks a retrieval question when
it detects struggling or dense-text skimming. A wrong answer gets an explanation with 2-4 key terms
highlighted; a correct one gets confirmation and nothing else. It can also generate on-demand
summaries, speak paragraphs aloud, and adapt its visual presentation.

The extension supports:
- **Ordinary web pages** (articles, documentation, Wikipedia, etc.): full detection, questions,
  the quiz, coverage tracking.
- **Local PDF and PPTX files**, opened from your computer: text extraction and the manual `Alt+S`
  summary work. **Detection, retrieval questions, and the quiz do not reach these formats yet**;
  they run on a separate paragraph model the signal pipeline can't see. See
  `src/content/pdf-handler.js` and `src/content/pptx-handler.js`.

Passage text is sent to a backend server (a separate repository, not part of this one) to generate
questions, explanations and summaries. Nothing else: no gaze data, because there is none, and no
reading history stored server-side. See [Privacy](#privacy).

---

## How It Works

```
Reading-signal detectors (scroll, pace, selection, copy, blur, cursor)
                    |
     comprehension-monitor.js (pace vs. difficulty vs. your baseline)
                    |
        state-engine.js  ->  on_pace / skimming / struggling / drifting / absent / unknown
                    |
      intervention-policy.js (interruption budget, dismissal-aware backoff)
                    |
     Action: retrieval question, nudge, or nothing
```

1. **Detectors** (`src/content/signals/`) watch scroll behaviour, reading pace, text selection,
   copy events, tab focus, and cursor position. No permission needed; nothing observes you doing
   anything other than using the page normally.
2. **`comprehension-monitor.js`** compares reading pace against the text's measured difficulty and
   your own running baseline (kept per language), correcting for a reader who is simply naturally
   fast or slow.
3. **`state-engine.js`** fuses the signals into one of six states. `unknown` is a valid, common
   answer and never interrupts.
4. **`intervention-policy.js`** decides whether a state earns an interruption: at most one every
   three minutes, a session cap that scales with how much has actually been read, and a backoff
   that kicks in after repeated dismissals.
5. **The action** is almost always a retrieval question (`question-card.js`), with the sentence the
   answer came from quoted underneath so the reader can check the evidence. A `drifting` state
   gets a nudge instead. Explaining is the failure path, reached only after a wrong answer.

There is no classifier and no trained model anywhere in the shipped extension. Every judgement
above is a plain, inspectable rule over measured values.

---

## Features

### Reading and questions
| Feature | Description |
|---|---|
| **Retrieval question** | The primary intervention. Confirmation only on a correct answer; an explanation with the passage quoted and 2-4 key terms highlighted on a wrong one |
| **Confidence rating** | Captured at the same moment as the answer, not as a follow-up probe. A probe that appears more after wrong answers would leak the result |
| **The quiz** | 5-8 questions drawn from what you've actually read on a document, offered once you've covered enough of it. One server call, local-only (IndexedDB), no retake, deletable |
| **The reading receipt** | `Alt+I` builds a local record of what was covered and recalled. Can be signed by the server as *unaltered since issued*, never as a claim that reading happened |
| **Snooze** | Explicit, reader-chosen pause (15 min / 1 hour / rest of today) on interruptions. Detection and coverage tracking keep running underneath it |
| **Text selection summaries** | Select text with the mouse for an instant summary popup |
| **Comprehension monitoring** | Reading too fast through dense text, or too slow against your own baseline |
| **Scroll backtrack detection** | Detects re-reading and can offer a summary |
| **Summary caching** | Responses cached per session by a `mode:fingerprint` key |

### Visual aids
| Feature | Description |
|---|---|
| **Dark Mode** | Themes the popup UI and in-page overlays. Toggle in the popup header |
| **Reading Map** | Collapsible sidebar: progress, a heading minimap, an event log. `Alt+M` |
| **Focus Ruler** | Dims everything above and below a band that follows your cursor, falling back to a fixed reading-line heuristic when the cursor hasn't moved recently. `Alt+F` |
| **Paragraph highlight** | The paragraph that triggered an action is briefly outlined |

### Reading personas
Four presets that set several toggles at once, from the popup's **Reading Mode** section:

| Persona | What it sets |
|---|---|
| **Research** | selection, paragraph highlight, comprehension, focus ruler, pin popups open |
| **Study** | comprehension, read-aloud, autohide after 10s |
| **Casual** | selection only, autohide after 6s |
| **Speed** | focus ruler, autohide after 4s, comprehension off |

### Accessibility
| Feature | Description |
|---|---|
| **Dyslexia Mode** | Verdana/Arial, 2x line height, wider letter/word spacing, left alignment, optional colour overlay |
| **Bionic Reading** | Bolds the first ~45% of each word as a visual anchor |
| **Read Aloud (TTS)** | Web Speech API, sentence by sentence, current word highlighted. `Alt+T` |

### Document support
| Format | What works |
|---|---|
| **Web pages** | Everything above |
| **Local PDF** | `file://*.pdf` is redirected to a bundled PDF.js viewer; text extraction and `Alt+S` summaries work. No detection or questions, see [Overview](#overview) |
| **Local PPTX** | Same shape as PDF, via a bundled JSZip-based viewer |

---

## Reading States

Six states, each naming an **observation**, not a feeling:

| State | What was observed | What it earns |
|---|---|---|
| `on_pace` | Pace matches the difficulty of the text and your own baseline | Nothing |
| `skimming` | Moving faster than this text usually takes to read | A question, but only on difficult text (skimming easy prose is a choice) |
| `struggling` | Slower than your usual pace here, or going back over it | A question; an explanation if the answer is wrong |
| `drifting` | Movement on the page has stalled without you leaving it | A nudge on the current paragraph |
| `absent` | Nothing to read from; you are away from the page | Nothing |
| `unknown` | The signals do not agree, or there is no signal | **Nothing, ever.** This is a valid and common answer |

There is deliberately no `confused` and no `overloaded`. Those named an internal state a browser
cannot measure, and were the previously-removed camera classifier's vocabulary.

## Reader Profiles

- **Professionals** (lawyers, doctors, analysts): comprehension monitoring flags paragraphs read
  faster than their difficulty warrants; the personal baseline adapts to a naturally fast
  professional reading pace so it doesn't false-trigger.
- **Students**: reading calibration sets a personal WPM baseline; the quiz and receipt give
  something to review after the fact; Dyslexia Mode and bionic reading are available if needed.
- **Dyslexic readers**: turn on Dyslexia Mode in the Accessibility tab, font, spacing and colour
  overlay adjust immediately; Focus Ruler helps with losing a line; TTS gives a parallel channel.
- **Non-native speakers / language learners**: AI responses come back in the same language as the
  passage; backtrack detection catches sentences that needed a second read.
- **Researchers / academics**: difficulty scoring accounts for genuinely dense material rather than
  flagging it as slow reading by default; the personal baseline adjusts to a dense-literature pace.

---

## Multilingual Support

Word and sentence counting goes through `Intl.Segmenter`, so pace signals work correctly in
scripts that don't put spaces between words (Chinese, Japanese, Thai, Khmer, Lao, Burmese) as well
as space-delimited ones. A whitespace-split word count used to return `1` for an entire CJK
paragraph, silently disabling detection on those pages. Difficulty scoring falls back to sentence
and clause structure with per-script anchors where Flesch-Kincaid doesn't apply, so ordinary prose
in Arabic or Chinese isn't scored as unusually dense by an English-shaped formula. AI responses
come back in the same language as the passage being read. Reading-pace baselines are kept per
language.

There is no script-aware feature patching of any kind. That machinery existed only to correct the
now-removed gaze classifier's training bias, and left with it.

---

## Architecture

See [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)'s "Repository layout" section for the
kept-current file tree. Duplicating it here is exactly how this file went stale
last time. In short: `src/content/` holds the content-script modules (reading-signal detectors
under `signals/`, the state engine, the interruption policy, the question card, the quiz); `src/popup/`
holds the toolbar panel and its pages; `src/shared/` holds the backend-origin config and the
install-token client; `background.js` is a thin message relay and the local-file PDF/PPTX redirect.

---

## Installation

### Prerequisites
- Google Chrome (or Chromium-based browser), or Firefox via the `firefox` build target
- Node.js >=20 (for this repo's own tooling: lint, tests, build)
- A running instance of the backend (separate private repository)

### Load the extension

1. Clone this repository and run `node build.mjs` from the repo root (or load `alcoia/` directly;
   its `manifest.json` is generated and committed for unpacked development).
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the `alcoia/` folder (the one containing `manifest.json`).

### Allow file access (for local PDF and PPTX viewing)

On `chrome://extensions`, click **Details** next to alcoia and enable **Allow access to file
URLs**. Required for the local-file viewers to fetch the file itself.

---

## Running the Backend Server

The extension calls a backend for question generation, explanations, summaries and receipt
signing. That backend's source is not part of this repository, see `../docs/ARCHITECTURE.md`'s
Scope table. Get its setup instructions from that repository.

By default the extension points at the real production origin, `https://server.alcoia.app`
(`src/shared/config.js`). Point it at your own instance from the popup's Settings > **Backend URL**
field (stored as `sra_backend_url`), no code or manifest edit needed. The endpoints the extension
calls:

```
POST /api/token          issues the opaque per-install token every other call must carry
POST /api/summarize      { text, mode, context? } -> { summary }
POST /api/questions      { text, count } -> { questions: [...] }
POST /api/receipt/sign   signs a reader-built receipt
```

**Every AI call carries the install token** (`X-Alcoia-Install-Token` header) issued by
`/api/token` and stored locally; a 401/403 clears it and a fresh one is requested on the next call.
See `../docs/ARCHITECTURE.md`'s Access control section for the full mechanism.

### Magic-link sign-in (item S3, paid tier)

```
POST /api/auth/magic-link                      { email, kind: 'extension' } -> sends the email
POST /api/auth/extension-session/exchange       { code } -> { token, email, expires }
```

The install token above is unrelated to this and unaffected by it — free features never need an
account. `POST /api/auth/magic-link`'s exact request shape is ASSUMED (see
`src/shared/session.js`'s own header); the exchange endpoint's path is the one thing
`SERVER-ARCHITECTURE.md` §4 names explicitly.

The reader never types a code into this extension. The Phase 1 landing page (`alcoiaWeb`, a
separate repo) verifies the emailed link, gets a one-time code from the exchange flow above, and
hands it to this extension via `chrome.runtime.sendMessage(EXTENSION_ID, { code })` —
`background.js`'s `chrome.runtime.onMessageExternal` listener is the only thing that can receive
that, and only from the origin declared in `manifests/base.json`'s `externally_connectable`
(currently a **dev value**, `http://localhost:8080` — see `build.mjs`'s own comment on that entry
and `src/shared/config.js`'s `WEB_APP_ORIGIN` for what has to change together before a real
launch. `alcoia.app` itself is live as of this writing, so this is now a matter of pointing the
existing constant and manifest entry at it, not waiting on the domain.)

---

## Usage Guide

### First use

1. Navigate to any page with text.
2. That's it: reading-signal detection starts immediately, no permission prompt and no setup step.

### Optional: reading calibration

In the popup's **Reading** tab, **Measure my reading speed** shows a passage blurred until you
start; read it at your natural pace and press the button when you finish. This sets your personal
WPM baseline, kept per language, and persists until you run it again. No camera involved.

### Day-to-day

- A retrieval question appears when detection flags struggling or dense-text skimming
- A correct answer ends it with confirmation only; a wrong one shows an explanation with the
  passage quoted and key terms highlighted
- Near the bottom of a document you've read enough of, an unprompted quiz offer appears. It's
  reader-initiated, so it doesn't spend the interruption budget
- **Select any text** for an instant summary
- **Press `Alt+S`** to summarise the paragraph at the viewport centre manually

### Reviewing what you've read

- `Alt+I`: the reading receipt for this session
- `Alt+R`: review what you've read this session
- `Alt+G`: the session report page
- The quiz, once taken, is reviewable (not retakeable) from wherever it was offered

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Alt+S` | Summarise the paragraph at the viewport centre |
| `Alt+T` | Toggle Read Aloud (TTS) |
| `Alt+F` | Toggle Focus Ruler |
| `Alt+M` | Toggle Reading Map sidebar |
| `Alt+N` | Open Saved Notes page |
| `Alt+G` | Open Session Report page |
| `Alt+I` | Show the reading receipt |
| `Alt+R` | Review what you've read this session |
| `Esc` | Close the active popup |
| `Alt+1` | Simulate: struggling state (testing) |
| `Alt+2` | Simulate: struggling state, forced to the simplify renderer |
| `Alt+3` | Simulate: drifting state |
| `Alt+4` | Simulate: skimming state |
| `Alt+5` | Simulate: on-pace state |

All shortcuts are listed in the popup for discoverability.

---

## Configuration

Settings live in `chrome.storage.local` under `sra_*` keys and survive browser restarts, changed
from the popup. Rather than duplicate the full list here (the drift risk that made this file stale
the first time), **the diagnostics page** (popup > Developer section) shows every local `sra_*`
setting live, plus install-token status and a capped log of silently-failed AI calls. A few of the
more load-bearing keys: `sra_enabled` (master on/off), `sra_backend_url`, `sra_comprehension`,
`sra_baseline_wpm_by_lang` (per-language WPM baseline), `sra_snooze_until`, `sra_install_token`.

---

## Accessibility

### Dyslexia Mode
Self-declared toggle in the **Accessibility** tab. Applies a high-legibility font, 2.0 line height,
wider letter/word spacing, left alignment, and an optional colour overlay.

### Bionic Reading
Sub-option under Dyslexia Mode. Bolds the first ~45% of each word as a visual anchor.

### Focus Ruler
A dim-band follows your cursor position when it's moved recently and is over body text; otherwise
it falls back to a fixed reading-line heuristic, the same anchor the paragraph tracker uses to
decide which paragraph is active. Off by default. `Alt+F`.

### Read Aloud (TTS)
Web Speech API, browser-native, works offline. Speaks the triggered paragraph sentence by sentence
with the current word highlighted. `Alt+T`.

### Dark Mode
Themes the popup UI and every in-page overlay. Preference persists across sessions.

---

## Privacy

Full detail lives in the top-level [`../README.md`](../README.md#privacy) and
[`../PRIVACY.md`](../PRIVACY.md); this is the short version specific to this reference:

- No camera path exists in this extension. No `getUserMedia` call, no hidden mode, no fingerprinting.
- Passage text is sent to the backend to generate questions, explanations and summaries: the one
  thing that leaves your machine, stated plainly rather than buried.
- Colour highlights (Ctrl+drag) and the quiz both keep reading content on disk, locally only,
  never synced. Highlights persist the highlighted text and its surrounding context so the same
  passage can be re-found on a later visit; the quiz persists in IndexedDB. Both are deletable:
  a single highlight, every highlight on a page, or all of them; a single quiz or all of them.
- Settings, the WPM baseline, and UI preferences persist locally and are not reading content.

---

## Security

- **Install-token gated.** Every AI call carries an opaque, issued-not-derived token
  (`src/shared/install-token.js`). No token, no response. It identifies an install, not a person or
  device; no fingerprinting of any kind is used or considered.
- **No remote code.** PDF.js and JSZip are bundled locally; nothing is fetched from a CDN.
- **Input sanitisation.** All text rendered in popups and the quiz is HTML-escaped before
  insertion; nothing the server returns is ever parsed as markup.
- Server-side controls (rate limiting, CORS, secret handling) live in the separate backend
  repository and are out of scope here, see `../docs/ARCHITECTURE.md`'s Scope table.

---

## Development Notes

### Adding a new reading state
There is no classifier to edit. Register the type in `state-engine.js`'s `fromSignal()` with a
confidence and an evidence sentence (or as a corroboration-only type in `CORROBORATING_TYPES` /
`CORROBORATION`); an unregistered type is silently ignored.

### Adding a new reading-signal detector
Goes in `src/content/signals/`, exporting `{ update(), signal() }`.

### Changing the AI model
Lives entirely in the separate backend repository. The extension is model-agnostic.

### Adding a new reading persona
In `popup.js`, add a key to the `MODES` constant with the desired toggle values, then a
corresponding `<button class="mode-btn" data-persona="...">` in `popup.html`.

### Extension permissions explained

| Permission | Reason |
|---|---|
| `storage` | Save settings, notes, sessions, quiz records |
| `activeTab` | Communicate with the current tab |
| `tabs` | Read tab URL for `file://` interception; create new tabs |
| `webNavigation` | Detect a single-page app's own route change (`history.pushState`), so reading detection resets between articles on sites that never do a full page reload |
| `file:///*` | Fetch local PDF/PPTX files in the viewer pages |

---

*Built by CJ_. Powered by PDF.js and JSZip.*
