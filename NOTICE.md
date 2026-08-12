# Licensing notice

## Scope of the AGPL-3.0 grant

`LICENSE` (AGPL-3.0) covers the alcoia **browser extension client** — everything under
`alcoia/` except `alcoia/src/libs/` — plus the training material under `tldr classifier/`.

`alcoia/server/` has moved out of this repository entirely, to a separate private repo. It was
never covered by this grant while it was here (proprietary, and this repo's LICENSE only ever
applied to the client). See "Still open" below for what removing it from the working tree does,
and does not, do to git history.

One remaining carve-out:

| Path | Status |
|---|---|
| `alcoia/src/libs/` | Third-party code under its own licence — see below. |

## Bundled third-party code

Verified by reading the licence headers in each shipped file:

| File | Licence | Copyright |
|---|---|---|
| `src/libs/webgazer.min.js` | **GPLv3** (LGPLv3 available to companies valued under $1M) | 2016 Brown WebGazer Team |
| `src/libs/pdfjs/pdf.min.js` | Apache-2.0 | 2023 Mozilla Foundation |
| `src/libs/pdfjs/pdf.worker.min.js` | Apache-2.0 | 2023 Mozilla Foundation |
| `src/libs/jszip.min.js` | MIT or GPLv3 (dual); bundles pako (MIT) | Stuk |
| `src/libs/fonts/literata-*.woff2` | **SIL OFL 1.1** — `OFL-Literata.txt` alongside | 2017 The Literata Project Authors |
| `src/libs/fonts/plus-jakarta-sans-*.woff2` | **SIL OFL 1.1** — `OFL-PlusJakartaSans.txt` alongside | 2020 The Plus Jakarta Sans Project Authors |

Two fonts are bundled: **Literata** (reading voice) and **Plus Jakarta Sans** (UI voice), latin and latin-ext subsets, roman and italic, variable weight. Both are SIL
OFL 1.1, which permits bundling and redistribution provided the licence travels with the
binaries and the Reserved Font Names are not applied to modified copies. Neither has been
modified. Both licences ship in `src/libs/fonts/`. **Any further font binary must arrive with
its licence file in the same directory.**

~~Fonts are currently fetched from Google.~~ **Fixed.** `fonts.googleapis.com` is no longer
requested anywhere: `content.js` injects the packaged `src/styles/fonts.css` instead, and the
popup, notes, highlights, export, session-report, PDF and PPTX pages link it too. The previous
arrangement sent Google one request per page the reader opened, carrying their IP and the
referring page — a third-party request tied to browsing activity, in a product whose pitch is
that it does not do that. `PRIVACY.md` §5 no longer needs to disclose it.

## What WebGazer's licence actually means here

1. **While WebGazer ships inside the extension package, the client can never be
   closed-source.** The shipped extension is a combined copyleft work, so the full
   corresponding source must be offered to anyone who receives it, including via the
   Chrome Web Store. This is permanent and it is the only consequence that constrains
   future decisions.

2. **AGPL-3.0 is compatible.** §13 of GPLv3 and §13 of AGPLv3 each permit the
   combination. `LICENSE` is correct and does not need changing.

3. **The $1M threshold is irrelevant to this project.** The LGPL option exists to allow
   proprietary linking. This project is copyleft by choice, so crossing the threshold
   simply leaves it under GPLv3 — where it already is. It is not a blocker on billing,
   pricing or incorporation.

4. **The server is unaffected.** It is a separate program in a separate process
   communicating over a network API. WebGazer's copyleft does not reach it, and its move to
   a separate private repo is unaffected by anything in this file.

5. **AGPL's network clause does almost nothing here.** An extension runs on the user's
   machine; they already receive the code, and nobody deploys an extension as a network
   service. The protection comes from ordinary distribution copyleft. Do not cite the
   network clause as a deterrent in documentation or marketing.

**WebGazer is unmaintained.** Official maintenance ended 24 February 2026. It still works;
updates are not guaranteed.

## Still open

1. **`server/` has been removed from the working tree, not from history.** It no longer
   exists anywhere under `alcoia/` in this repository as of the change that added this
   note. Two pure, dependency-free modules from it (`questions.js`, `receipt-signing.js`)
   were copied into `tests/contract/` as vendored fixtures so the client's assumptions
   about the server's contract — the verbatim-span requirement, the receipt canonicalisation
   format — stay under test; they are not shipped and are not the AGPL-covered client. The
   original `server/` code, including the deleted Express app and `.env` handling, is still
   present and still public in this repo's git history. Removing it from the working tree
   does not remove it from history; a history rewrite or a fresh repository is still required
   if that matters.

2. **Exit path from WebGazer — logged, not scheduled.** Gaze is now demoted to presence and
   coarse region. A small MediaPipe FaceMesh implementation (Apache 2.0) would cover what
   remains, remove the GPL obligation and drop a dead dependency. Do not undertake this
   without asking.
