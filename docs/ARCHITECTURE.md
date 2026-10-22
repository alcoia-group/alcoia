# alcoia: architecture

This file explains how alcoia works. If it disagrees with the shipped code, the code is correct.

---

## Product intent

alcoia is a browser extension (Chrome MV3; a Firefox build target exists and is tested less) that notices when a reader is
struggling with a page and intervenes with a **retrieval question** about what they just read.

alcoia's stated purpose is to make the reader need it less over time. A correct answer to a
retrieval question ends the interaction with confirmation only, no explanation, no elaboration.
Explanation is reached only after a wrong answer, or when no question could be generated; it is
never the default path. The design intent is that the cheapest path through the system is the
successful one, and that any adaptation which reduces how often the reader is interrupted is gated
on demonstrated competence, answer accuracy at escalating difficulty, never on interruption count
or dismissal rate by itself, since both a genuinely improving reader and a reader who has simply
learned to avoid triggering the system look identical in raw interruption-frequency data.

## Signal hierarchy

Two sources, in order of authority:

1. **Reader responses.** The only ground truth. A correct answer resolves to `on_pace`. A dismissal
   asserts nothing, declining to be tested says nothing about comprehension, and is never read as
   either success or struggle.
2. **Browser reading signals.** Reading rate versus text difficulty and personal baseline, scroll
   regressions, selection, copy, and tab blur/focus. This is the only detection path, precise,
   always available, and requires no permission prompt.

How the browser signals are read (all in `alcoia/src/content`, none of it sent anywhere):

- **Expected time is continuous and personal** (`signals/reading-time-model.js`). A paragraph's expected time is its words at the reader's own pace, scaled by the share of rare words and the mean clause length, with the scaling fitted online per language (ridge regression pulled towards stated priors, bounded, trimmed against outliers). There are no grade steps. A "very difficult" paragraph is judged like any other; it is simply expected to take longer.
- **Screen mode** (`signals/screen-timing.js`). A reader who moves a whole screen at a time (Page Down, Space, a big flick) is timed per screen: the time between jumps against what the paragraphs visible on that screen should take. The per-paragraph path stays quiet in that mode.
- **Two pieces of evidence before struggle** (`signals/struggle-evidence-rule.js`, rule `two_evidence_before_struggle`). One slow paragraph is held, not acted on. It is released when a genuine re-read follows within two minutes, or when a different paragraph is also slow. Self-reports, backtracks and a confirmed re-read on its own are unchanged. Switch off with `evidenceRuleOpts: { enabled: false }`.
- **Word lists.** English has a 10,000-word list built from public-domain books; French, Spanish, German, Portuguese and Italian have 5,000-word lists (`tools/build-wordfreq-lang.mjs`, source and licence in `docs/NOTICE.md`). A list loads the first time a page in that language is read. The share of words outside the list feeds the time model; it does not change those languages' difficulty score.
- **Scheduled quick checks** ask about a paragraph chosen at random from those already read since the last check, never the one just read, and never the same paragraph twice in a session.

All the numbers named in these modules (jump size, window, priors, bounds) are provisional and unvalidated; they are constants at the top of each file.

There is no camera path. No sensor, no classifier, no calibration flow, and no code path anywhere
in the extension reads a gaze coordinate, a video frame, or any camera-derived signal. This is a
structural property of the shipped code, not a setting that can be turned on.

## Scope

**In this repository:** content scripts, reading-signal detectors, the state engine, the interruption
policy, the question card, the quiz, the reading receipt, the popup and extension pages, styles, and
the build.

**Not in this repository:**

| Thing | Where |
|---|---|
| API server | Separate private repository |
| Accounts, entitlements, install tokens, assist counter | Server (client displays; server decides) |
| Question generation and validation | Server (the client consumes questions; it never authors them) |
| Aggregate class analytics | Server (cohorts cannot be aggregated on one client) |
| Educator / team portals | Separate web app |
| Pricing, tiers, legal text | Human decision, scaffolded only where it touches this repo |

## Statefulness

The server holds accounts, entitlements and an assist counter. It does not hold a record of what any individual reader has read. The extension sends passage text to the server to generate a question or explanation, and the server does not keep it beyond a short cache.

Some signed-in features send more:

- With account-based learning on, answers to questions are stored on the account, as tallies per passage and idea, never as page text or addresses.
- For a class assignment, answers and difficulty signals are reported under the reporting mode (anonymous or identified) shown when the student joins.
- Anonymous daily counters (for example failed question generations) are sent only when the server enables them.
- Signed in, eleven reading settings (on/off, which cards to show, dyslexia overlay and tint, dark cards, auto-hide and its delay, explain on highlight, colour highlights, document links) are saved on the account, so the same choices apply in every browser and in the alcoia workspace (`src/shared/account-sync.js`, run by the background script).
- Signed in with account-based learning on, the reading-speed baseline (words per minute, overall and per language) is saved on the account, so detection starts from the reader's own pace on a new device. Numbers only.

Other UI preferences, the reading receipt, colour highlights, notes and completed quiz records stay in local browser storage (`chrome.storage.local` / IndexedDB) and are never uploaded. Signed out, settings and the baseline stay local too.

The alcoia workspace (workspace.alcoia.app) runs this extension's detection code itself on assigned readings and on the reader's own files, so a student needs no install there. A workspace page that does so carries `<meta name="alcoia-detection" content="workspace">`; on the workspace origin only, the content script then does nothing, so a reader never gets two detectors.

## Access control

No account is required to use the extension, free install, no signup, no email. AI calls (question
generation, summaries, explanations) are gated by an opaque install token: on first run the
extension requests one from the server and stores it locally; every AI call carries it; the server
counts against it and enforces a ceiling. The token identifies an install, not a person or a
machine, it is not derived from any device or network fingerprint, explicitly, as a matter of
policy. There is no visible quota in the reading UI; the token's status is visible only on the
extension's own diagnostics page, for support purposes.

## Hard invariants

These are architectural commitments the codebase is built to enforce, not configuration options:

1. **No covert monitoring.** No hidden mode, no silent-collection flag, no observation without the
   reader's own action.
2. **No camera path.** No frames, camera data or image data appear in any request.
3. **No accuracy claims** in code, comments, UI, or docs.
4. **Receipts are reader-generated only.** No background submission; the reader sees the contents
   before ever sharing one.
5. **`unknown` is a valid, common state.** The system never interrupts on it, and never substitutes
   a plausible-looking default for genuinely missing data.
6. **No raw gaze coordinates** in any persisted or transmitted artifact.
7. **Never accuse.** A receipt reports "unaltered since issued," or nothing, never "verified,"
   never "authentic."
8. **Never test a reader who did not read.** A drifting reader, or one below a measured coverage
   threshold, is prompted to re-read first; a question comes after, not instead.
9. **Every failure degrades to silence.** A server error, a timeout, malformed model output, or an
   extraction failure all resolve to `unknown`, and `unknown` never interrupts.
10. **No page text is transmitted for storage.** Passage text is sent only to generate a question or explanation.

## Interruption budget

Reader attention is treated as the scarcest resource in the product. The policy: at most one
interruption per three minutes; a per-session cap that scales with content read exists in the
code (`SESSION_CAP_ENABLED` in `intervention-policy.js`) and is switched off for now;
consecutive dismissals raise the bar for the next one; the same paragraph is never interrupted on
twice; interruptions require a measured minimum confidence; and every interruption shows the reader
the specific evidence that triggered it (e.g. "you slowed down a lot here"), converting an inference
into something the reader can check for themselves.

## The quiz

Reader-initiated, offered at the end of a reading session once enough of a document has genuinely
been read (a coverage-and-dwell-time gate, not scroll position alone, since scrolling to the bottom
of a page is trivially fakeable in seconds and proves nothing about reading). Selection of which
paragraphs to ask about is weighted toward paragraphs the reader struggled with, without guaranteeing
every question comes from a mistake, asking only about failures would turn the quiz into a list of
the reader's own errors. Results are shown as a plain factual tally, never a percentage, never
compared across sessions. The whole record, questions, the reader's answers, confidence ratings,
and verdicts, is stored locally only, is deletable per-quiz or all at once, and is never retaken
against the same generated questions (there is no retry-until-correct loop).

## Confidence calibration

When answering a retrieval question, the reader can optionally rate their own confidence
(low/high) at the same moment they commit an answer, not as a separate post-hoc probe, which would
otherwise leak the correctness of the answer through when the probe appears. The four resulting
outcomes (correct+high, correct+low, wrong+high, wrong+low) get distinct but never punitive copy,
a confidently wrong answer is treated as the most valuable case for learning, not one to feel worse
about than an unsure wrong answer.

## Claims discipline

No accuracy percentage for detection appears in shipped code, UI copy or documentation. Detection has not been evaluated with real participants. Any figure in the historical training material under `archive/` was measured on synthetic or self-generated data and supports no claim about the product.

## Type and colour

- Fonts: Literata (reading) and Plus Jakarta Sans (UI), bundled under SIL OFL 1.1. Nothing is
  fetched from a third party at runtime.
- Palette: warm paper, matte, never pure white, never pure black.
- One reserved colour (a muted sage) is used exclusively for content the *system itself* produced,
  the evidence badge, the quoted passage span, a correct answer, and nowhere else, so its meaning
  stays legible by staying rare.
- No gradients, glows, or shadows on interactive controls; the floating question card is the one
  deliberate exception to that rule.

## Repository layout

```
.
├── LICENSE                 AGPL-3.0, see NOTICE.md for exactly what it covers
├── SECURITY.md              vulnerability reporting
├── build.mjs                per-target package build (no bundler, a source-tree copy plus a
│                             generated manifest per target)
├── manifests/                shared manifest source (base.json + one override per target)
├── tests/                    unit test suite (Vitest) + a real-browser smoke check
├── tools/question-quality.mjs  question review harness
├── archive/                  historical notebooks + synthetic training data (unused by the extension)
└── alcoia/
    ├── manifest.json          generated from manifests/, not hand-edited
    ├── background.js          the MV3 service worker: the file:// PDF/PPTX redirect, the SPA
    │                           route-change detector, and a thin authenticated proxy for AI calls
    ├── src/content/            the content-script pipeline: detectors feed a state engine, which
    │                           feeds an interruption-budget policy, which, only on a yes, renders
    │                           the question card, the quiz offer, or a summary popup
    │   └── signals/             individual signal detectors (scroll behaviour, selection, blur,
    │                           paragraph-level reading pace), none of them require a permission
    │                           prompt or a sensor
    ├── src/popup/              the popup and every standalone extension page (diagnostics, the
    │                           quiz, highlight management, session reports, notes export)
    ├── src/shared/              the one place the backend origin is configured, and the install
    │                           token manager
    ├── src/styles/              shared CSS
    ├── src/libs/                third-party code (PDF.js, JSZip, bundled fonts), see NOTICE.md
    ├── src/pdf-viewer/          a standalone local-file PDF viewer, used because Chrome's own PDF
    │                           viewer runs in a sandboxed renderer a content script cannot reach
    └── src/pptx-viewer/         the same idea, for local .pptx files
```

## Conventions

- ES modules; content-script modules load dynamically at runtime, which is why they must be listed
  in the manifest's `web_accessible_resources`.
- The orchestrator decides what to show; a separate UI-controller module renders it and owns the
  single source of truth for what is currently on screen.
- Renderers are never called directly by a detector, a detector only ever updates the state engine,
  and the state engine's own subscriber is the one path to the reader.
- Tests: unit tests (Vitest) prioritise extractors against fixtures, the state engine against
  synthetic signal sequences, the interruption budget, and every failure path resolving to silence.
  A separate real-browser check exercises what a unit test cannot reach at all, extension
  messaging, the manifest, and end-to-end behaviour in a real Chromium instance.
- No new runtime dependencies are added without a deliberate decision to do so.

## Verifying this yourself

```bash
npm run lint && npm test
npm run test:browser            # runs the extension in a real, unpacked Chromium load
node build.mjs                  # produces both build targets
```

Then load the extension unpacked and confirm manually: it loads with no console errors on a plain
article page; reading detection runs on reading signals alone, since there is no camera path to be off;
no `getUserMedia` call is ever made; no network request contains image or video data; and no
third-party request is made at all in the course of ordinary use.
