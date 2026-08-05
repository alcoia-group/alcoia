# Licensing notice

## Scope of the AGPL-3.0 grant

`LICENSE` (AGPL-3.0) covers the TL;DR **browser extension client** — everything under
`TL_DR/` except `TL_DR/server/` and `TL_DR/src/libs/` — plus the training material under
`tldr classifier/`.

Two carve-outs:

| Path | Status |
|---|---|
| `TL_DR/server/` | **Not covered by this grant.** Proprietary; scheduled to move to a separate private repository. Until that move happens, no licence is granted for it. |
| `TL_DR/src/libs/` | Third-party code under its own licence — see below. |

## Bundled third-party code

Verified by reading the licence headers in each shipped file:

| File | Licence | Copyright |
|---|---|---|
| `src/libs/webgazer.min.js` | **GPLv3** (LGPLv3 available to companies valued under $1M) | 2016 Brown WebGazer Team |
| `src/libs/pdfjs/pdf.min.js` | Apache-2.0 | 2023 Mozilla Foundation |
| `src/libs/pdfjs/pdf.worker.min.js` | Apache-2.0 | 2023 Mozilla Foundation |
| `src/libs/jszip.min.js` | MIT or GPLv3 (dual); bundles pako (MIT) | Stuk |
| `src/libs/fonts/Merriweather-*.woff2` | Not verified — no licence file shipped alongside | — |

## Open licensing questions — require a human decision

These are flagged, not resolved. Do not treat the table above as legal advice.

1. **WebGazer is GPLv3, and it ships inside the extension.** The distributed extension is
   therefore a combined work subject to copyleft. AGPL-3.0 is compatible with GPLv3 for
   this purpose, so the choice of AGPL for the client holds — but the consequence is that
   **the full corresponding source of the shipped extension must be offered to anyone who
   receives it**, including via the Chrome Web Store.

2. **WebGazer's dual-licence threshold interacts with the commercialisation plan.** The
   LGPLv3 option is offered only to companies valued under $1M. If TL;DR takes revenue and
   crosses that line, the GPLv3 terms are what apply. Confirm the current WebGazer licence
   terms directly with its authors before shipping a paid tier.

3. **Merriweather's licence is unverified.** The `.woff2` files ship with no accompanying
   licence. Merriweather is normally OFL-1.1, but that has not been confirmed from the
   files in this repository. Either add the licence file or drop the fonts — note that
   `the project notes` already records a decision to retire Merriweather in favour of Literata,
   which would make this moot.

4. **`server/` has not actually been moved yet.** The carve-out above is a statement of
   intent recorded in the repository. The code is still present and still public in git
   history. Removing it from the working tree does not remove it from history; a history
   rewrite or a fresh repository is required if that matters.
