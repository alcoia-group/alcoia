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

Verified by reading the licence headers in each shipped file. `src/libs/webgazer.min.js` (GPLv3)
is no longer one of them — it was deleted along with the rest of the gaze path (see CLAUDE.md's
migration note under "Signal hierarchy"). What remains bundled is all permissive or OFL:

| File | Licence | Copyright |
|---|---|---|
| `src/libs/pdfjs/pdf.min.js` | Apache-2.0 | 2023 Mozilla Foundation |
| `src/libs/pdfjs/pdf.worker.min.js` | Apache-2.0 | 2023 Mozilla Foundation |
| `src/libs/jszip.min.js` | MIT or GPLv3 (dual); bundles pako (MIT) | Stuk |
| `src/libs/fonts/literata-*.woff2` | **SIL OFL 1.1** — `OFL-Literata.txt` alongside | 2017 The Literata Project Authors |
| `src/libs/fonts/plus-jakarta-sans-*.woff2` | **SIL OFL 1.1** — `OFL-PlusJakartaSans.txt` alongside | 2020 The Plus Jakarta Sans Project Authors |
| `src/libs/wordfreq/google-10000-english.txt` | Public domain (source texts, via Project Gutenberg) | Frequencies computed by this project — see below |

### `src/libs/wordfreq/google-10000-english.txt` / `common-words.js` — resolved

**Was flagged NEEDS REVIEW (item 13c): the original list
([first20hours/google-10000-english](https://github.com/first20hours/google-10000-english) on
GitHub, derived from the Google Web Trillion Word Corpus via the Linguistic Data Consortium) came
with an explicit "I do not recommend using this data for commercial purposes without licensing it
from the Linguistic Data Consortium" from its own author, and GitHub's own license detector
reported `"license":"other"`/`"spdx_id":"NOASSERTION"` — no clean permissive licence to point to,
for a commercial product. Replaced, not licensed after the fact.**

**Current source: computed by this project from Project Gutenberg's public-domain catalogue.**
`tools/build-wordfreq.mjs` (kept in the repo, not just its output — `npm run wordfreq:build` to
regenerate) fetches a curated batch of individually-named, well-known public-domain books —
novels, essays, standard prose translations — from `gutenberg.pglaf.org` (Project Gutenberg's own
official mirror, per [their mirror list](https://www.gutenberg.org/MIRRORS.ALL); confirmed
directly against
[gutenberg.org's own robot-access policy](https://www.gutenberg.org/policy/robot_access.html)
before writing the script, since gutenberg.org itself is "intended for human users only" and a
curated batch of specific ids is neither the sanctioned harvest endpoint nor a full mirror sync).
Each book's own Project Gutenberg licensing boilerplate is stripped before counting (the standard
`*** START/END OF THE PROJECT GUTENBERG EBOOK ***` markers), so word frequency reflects the books
themselves, not Project Gutenberg's own legal text repeated in every file. Project Gutenberg's own
texts in the US are public domain; nothing here is licensed, only counted.

Every book is named, by Gutenberg id, in `tools/build-wordfreq.mjs` itself — this section does not
duplicate that list. As built for this replacement: **49 books, ~6.5 million words tokenized,
top 10,000 by frequency kept** — the exact figures are in the commit that replaced this file, and
regenerating reports fresh ones on every run, since Project Gutenberg's own texts are corrected
over time (see their "Files change frequently" note on the policy page above).

**A real, structural tradeoff, stated rather than left implicit:** Project Gutenberg's catalogue
is overwhelmingly pre-1929-ish (US copyright term), so this list under-represents strictly modern
or technical vocabulary (a word like "middleware" or "authentication" will read as rarer here than
under the original web-crawl-derived list) — confirmed by a direct before/after comparison against
sample passages before this replaced anything, not assumed. For the plain, ordinary English
`text-difficulty.js` actually scores day to day, the two lists behave comparably; a passage dense
with contemporary technical jargon will now score as somewhat harder/rarer than it would have
under the old list. This is the honest cost of a public-domain-only source, not an oversight.

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

## What WebGazer's licence used to mean here — resolved, kept for the record

WebGazer (GPLv3) has been deleted from this repository, along with the rest of the gaze
detection path — the classifier it fed, the feature extractor, the calibration flow that trained
it, and the main-world bootstrap script that loaded it. This section used to explain the
consequence of shipping it; it no longer applies, but is kept so the reasoning survives the
removal, in case gaze detection or a similarly-licensed dependency is ever proposed again.

1. ✅ **Resolved: the "can never be closed-source while WebGazer ships" constraint is gone.**
   While WebGazer shipped inside the package, the extension was a combined copyleft work and the
   full corresponding source had to be offered to anyone who received it — permanent as long as
   WebGazer stayed, and the reason this section existed. With WebGazer removed, nothing left under
   `src/libs/` is copyleft (Apache-2.0, MIT-or-GPLv3-dual taken under MIT, and OFL 1.1 — see the
   table above), so that specific forcing function no longer applies.

2. **This does not change the licence choice itself.** `LICENSE` (AGPL-3.0) was always this
   project's own choice for the client, not something WebGazer imposed — GPLv3 and AGPLv3 are
   compatible under each licence's §13, so the combination was never a problem to begin with.
   Removing WebGazer removes a *reason* the client could not have gone permissive; it is not a
   reason to revisit AGPL-3.0 itself. Any change to that choice is a human decision — see
   CLAUDE.md's "Requires human approval" — not a side effect of this deletion.

3. **AGPL's network clause still does almost nothing here.** An extension runs on the user's
   machine; they already receive the code, and nobody deploys an extension as a network service.
   The protection comes from ordinary distribution copyleft. Do not cite the network clause as a
   deterrent in documentation or marketing.

4. **The server was always unaffected by any of this**, WebGazer included — it is a separate
   program in a separate process communicating over a network API, and its move to a separate
   private repo (see "Still open" below) is unrelated to the WebGazer removal.

**WebGazer was unmaintained** at the time of removal — official maintenance ended 24 February
2026 — which was one more reason deletion was preferable to continuing to carry it.

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

2. ✅ **Exit path from WebGazer — taken.** This used to log a possible future replacement (a
   small MediaPipe FaceMesh implementation, Apache-2.0) for whatever gaze capability remained.
   The decision made instead was removal, not replacement: no gaze detection ships at all now,
   so there is nothing left to replace and no GPL obligation to drop a replacement for.
