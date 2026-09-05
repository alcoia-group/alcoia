# alcoia — architecture

This file explains how alcoia works, for anyone verifying the transparency claim in `README.md`. It
is the public counterpart to a much longer internal engineering-context file (`CLAUDE.md`, not
published) that additionally tracks line-by-line implementation status, in-progress work, and open
engineering questions. If something here looks stale relative to the shipped code, the code is the
source of truth — this document is a map, not a spec.

---

## Product intent

alcoia is a browser extension (Chrome MV3, Firefox via a build target) that notices when a reader is
struggling with a page and intervenes with a **retrieval question** about what they just read.

alcoia's stated purpose is to make the reader need it less over time. A correct answer to a
retrieval question ends the interaction with confirmation only — no explanation, no elaboration.
Explanation is reached only after a wrong answer, or when no question could be generated; it is
never the default path. The design intent is that the cheapest path through the system is the
successful one, and that any adaptation which reduces how often the reader is interrupted is gated
on demonstrated competence — answer accuracy at escalating difficulty — never on interruption count
or dismissal rate by itself, since both a genuinely improving reader and a reader who has simply
learned to avoid triggering the system look identical in raw interruption-frequency data.

## Signal hierarchy

Two sources, in order of authority:

1. **Reader responses.** The only ground truth. A correct answer resolves to `on_pace`. A dismissal
   asserts nothing — declining to be tested says nothing about comprehension, and is never read as
   either success or struggle.
2. **Browser reading signals.** Reading rate versus text difficulty and personal baseline, scroll
   regressions, selection, copy, and tab blur/focus. This is the only detection path — precise,
   always available, and requires no permission prompt.

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

The server holds accounts, entitlements, and an assist counter — nothing more. It does not hold a
record of what any individual reader has read. Concretely: nothing in the extension transmits
reading *content* — paragraph text, question history, answers, concepts — to the server for
storage. Settings, the reading-speed baseline, and UI preferences are not reading content and
already persist locally.

Local persistence (on-device only, nothing transmitted) is a different thing from what the server
holds, and several features intentionally keep state only on the reader's own device: the reading
receipt, colour highlights, and completed quiz records all live in local browser storage
(`chrome.storage.local` / IndexedDB) and are never uploaded.

## Access control

No account is required to use the extension — free install, no signup, no email. AI calls (question
generation, summaries, explanations) are gated by an opaque install token: on first run the
extension requests one from the server and stores it locally; every AI call carries it; the server
counts against it and enforces a ceiling. The token identifies an install, not a person or a
machine — it is not derived from any device or network fingerprint, explicitly, as a matter of
policy. There is no visible quota in the reading UI; the token's status is visible only on the
extension's own diagnostics page, for support purposes.

## Hard invariants

These are architectural commitments the codebase is built to enforce, not configuration options:

1. **No covert monitoring.** No hidden mode, no silent-collection flag, no observation without the
   reader's own action.
2. **Video never leaves the device.** No frames, no raw camera data, no image data in any request —
   moot in the current build, since there is no camera path at all.
3. **No accuracy claims** in code, comments, UI, or docs.
4. **Receipts are reader-generated only.** No background submission; the reader sees the contents
   before ever sharing one.
5. **`unknown` is a valid, common state.** The system never interrupts on it, and never substitutes
   a plausible-looking default for genuinely missing data.
6. **No raw gaze coordinates** in any persisted or transmitted artifact.
7. **Never accuse.** A receipt reports "unaltered since issued," or nothing — never "verified,"
   never "authentic."
8. **Never test a reader who did not read.** A drifting reader, or one below a measured coverage
   threshold, is prompted to re-read first; a question comes after, not instead.
9. **Every failure degrades to silence.** A server error, a timeout, malformed model output, or an
   extraction failure all resolve to `unknown`, and `unknown` never interrupts.
10. **No reading content is transmitted for storage.**

## Interruption budget

Reader attention is treated as the scarcest resource in the product. The policy: at most one
interruption per three minutes; the per-session cap scales with content actually read rather than
with wall-clock session length, with an absolute ceiling so a pathological loop cannot spiral;
consecutive dismissals raise the bar for the next one; the same paragraph is never interrupted on
twice; interruptions require a measured minimum confidence; and every interruption shows the reader
the specific evidence that triggered it (e.g. "you slowed down a lot here"), converting an inference
into something the reader can check for themselves.

## The quiz

Reader-initiated, offered at the end of a reading session once enough of a document has genuinely
been read (a coverage-and-dwell-time gate, not scroll position alone, since scrolling to the bottom
of a page is trivially fakeable in seconds and proves nothing about reading). Selection of which
paragraphs to ask about is weighted toward paragraphs the reader struggled with, without guaranteeing
every question comes from a mistake — asking only about failures would turn the quiz into a list of
the reader's own errors. Results are shown as a plain factual tally, never a percentage, never
compared across sessions. The whole record — questions, the reader's answers, confidence ratings,
and verdicts — is stored locally only, is deletable per-quiz or all at once, and is never retaken
against the same generated questions (there is no retry-until-correct loop).

## Confidence calibration

When answering a retrieval question, the reader can optionally rate their own confidence
(low/high) at the same moment they commit an answer — not as a separate post-hoc probe, which would
otherwise leak the correctness of the answer through when the probe appears. The four resulting
outcomes (correct+high, correct+low, wrong+high, wrong+low) get distinct but never punitive copy —
a confidently wrong answer is treated as the most valuable case for learning, not one to feel worse
about than an unsure wrong answer.

## Claims discipline

No accuracy percentage for any classifier ever built as part of this project — including figures
that exist in historical training material under `tldr classifier/` — is presented in shipped code,
UI copy, or documentation as a claim about real-world detection reliability. Any such figure that
does appear anywhere in this repository is a measurement against synthetic or self-generated data,
explicitly not validated against real participants, and is never load-bearing for a claim the
product makes to a reader.

## Type and colour

- Fonts: Literata (reading) and Plus Jakarta Sans (UI), bundled under SIL OFL 1.1. Nothing is
  fetched from a third party at runtime.
- Palette: warm paper, matte — never pure white, never pure black.
- One reserved colour (a muted sage) is used exclusively for content the *system itself* produced —
  the evidence badge, the quoted passage span, a correct answer — and nowhere else, so its meaning
  stays legible by staying rare.
- No gradients, glows, or shadows on interactive controls; the floating question card is the one
  deliberate exception to that rule.

## Repository layout

```
.
├── LICENSE                 AGPL-3.0 — see NOTICE.md for exactly what it covers
├── SECURITY.md              vulnerability reporting
├── build.mjs                per-target package build (no bundler — a source-tree copy plus a
│                             generated manifest per target)
├── manifests/                shared manifest source (base.json + one override per target)
├── tests/                    unit test suite (Vitest) + a real-browser smoke check
├── tools/question-quality.mjs  question review harness
├── tldr classifier/          historical notebooks + synthetic training data
└── alcoia/
    ├── manifest.json          generated from manifests/ — not hand-edited
    ├── background.js          the MV3 service worker: the file:// PDF/PPTX redirect, the SPA
    │                           route-change detector, and a thin authenticated proxy for AI calls
    ├── src/content/            the content-script pipeline: detectors feed a state engine, which
    │                           feeds an interruption-budget policy, which — only on a yes — renders
    │                           the question card, the quiz offer, or a summary popup
    │   └── signals/             individual signal detectors (scroll behaviour, selection, blur,
    │                           paragraph-level reading pace) — none of them require a permission
    │                           prompt or a sensor
    ├── src/popup/              the popup and every standalone extension page (diagnostics, the
    │                           quiz, highlight management, session reports, notes export)
    ├── src/shared/              the one place the backend origin is configured, and the install
    │                           token manager
    ├── src/styles/              shared CSS
    ├── src/libs/                third-party code (PDF.js, JSZip, bundled fonts) — see NOTICE.md
    ├── src/pdf-viewer/          a standalone local-file PDF viewer, used because Chrome's own PDF
    │                           viewer runs in a sandboxed renderer a content script cannot reach
    └── src/pptx-viewer/         the same idea, for local .pptx files
```

## Conventions

- ES modules; content-script modules load dynamically at runtime, which is why they must be listed
  in the manifest's `web_accessible_resources`.
- The orchestrator decides what to show; a separate UI-controller module renders it and owns the
  single source of truth for what is currently on screen.
- Renderers are never called directly by a detector — a detector only ever updates the state engine,
  and the state engine's own subscriber is the one path to the reader.
- Tests: unit tests (Vitest) prioritise extractors against fixtures, the state engine against
  synthetic signal sequences, the interruption budget, and every failure path resolving to silence.
  A separate real-browser check exercises what a unit test cannot reach at all — extension
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
