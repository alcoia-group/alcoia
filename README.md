<p align="center">
  <img src="alcoia/assets/alcoia-wordmark-cream.png" width="440" alt="alcoia">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="License: AGPL-3.0"></a>
  <img src="https://img.shields.io/badge/version-0.2.0--pre--release-lightgrey.svg" alt="Version 0.2.0 (pre-release)">
</p>

<!--
  TODO(owner): a CI badge belongs here once a workflow exists — there is no
  .github/workflows/ in this repo yet, so none is added rather than pointing
  at a badge that would 404 or always read "no status".
-->

<!--
  TODO(owner): screenshot or short demo GIF of the retrieval-question card
  appearing on a real article. No placeholder image is included here on
  purpose — an AI-generated stand-in would misrepresent what the product
  looks like, which is worse than a visible gap. Drop the real capture at
  docs/demo.gif (or similar) and reference it here, e.g.:
  ![alcoia asking a retrieval question on a real article](docs/demo.gif)
-->

alcoia is a browser extension that notices when you've stopped reading and asks you a short
question about the passage instead of summarising it for you. It's built for anyone who reads
long things online and wants to actually retain them — students, researchers, anyone tired of
skimming and forgetting. It's open source so you can verify what it does with your reading data
rather than take that claim on trust.

## Quick start

**From the Chrome Web Store** (recommended once published):

<!-- TODO(owner): replace with the real Chrome Web Store listing URL once published. -->
[Chrome Web Store listing — not yet published](https://chrome.google.com/webstore)

**Load unpacked, for development or to inspect the code yourself:**

```bash
git clone <this repo>
cd alcoia
npm install          # tooling only — the extension itself ships unbundled
```

Then open `chrome://extensions`, enable **Developer mode**, and **Load unpacked** pointing at the
`alcoia/` directory.

## How it works

- Watches **reading signals only** — pace against text difficulty and against your own baseline,
  re-reading, selection, tab focus. No camera, ever.
- When it looks like you've stopped following the text, it asks a short **retrieval question**
  about the passage you just read, with the sentence containing the answer quoted underneath.
- Answering is the only thing that produces ground truth: a correct answer ends the interaction
  with confirmation only; a wrong one gets an explanation. Dismissing a question asserts nothing.
- An interruption budget (at most one every 3 minutes, never twice on the same paragraph, never
  on an inconclusive read) keeps it from becoming the thing that interrupts your reading.
- Full mechanism, in more technical detail than belongs here: [`alcoia/README.md`](alcoia/README.md)
  and [`ARCHITECTURE.md`](ARCHITECTURE.md).

<!--
  TODO(owner): once the marketing site exists (WEBSITE-BRIEF.md §9.2), link
  its /how-it-works page here instead of / alongside the two files above —
  it does not resolve yet (see alcoia/src/shared/config.js's own comment on
  WEB_APP_ORIGIN), so no live URL is included.
-->

## Privacy

**No camera, no permissions beyond what's shown, reading data stays on your device except passage
text sent for question generation.** That's the whole claim; everything else in this project is
in service of it staying true. The one thing that leaves your machine is the passage text needed
to generate a question or an explanation — no video or image data, no analytics, no third-party
scripts, and no covert mode, ever.

<!--
  This deliberately does NOT link PRIVACY.md — that file is an explicitly
  marked internal scaffold ("SCAFFOLD ONLY — NOT PUBLISHABLE... Do not let
  an agent fill it in", per CLAUDE.md §9's "requires human approval" list)
  and is not a real, published policy. Until one exists, the honest link is
  the code-derived data map below, not a document that says not to link it.
-->
For exactly what is stored, where, and for how long: [`LEGAL-DISCLOSURE-MAP.md`](LEGAL-DISCLOSURE-MAP.md).
*(A plain-language, human-approved privacy policy is planned for the public site; it does not
exist yet, so it isn't linked here — see that file's own status note.)*

## Why only the extension is public

The backend that generates questions and explanations lives in a separate, private repository —
this repo is the browser extension client only. It's public because a claim like the one above
("your reading data stays on your device") only means something if someone other than the people
making it can check it: the detection logic, the interruption budget, and everything that touches
your reading are all sitting right here, readable end to end. What isn't published is the account,
billing and question-generation server, which handles things — payment details, institutional
data — that being public wouldn't make more trustworthy, only more exposed.

## Development setup

```bash
git clone <this repo>
cd alcoia
npm install                     # tooling only — the extension ships unbundled

npm run lint                    # ESLint — a defect linter, not a style linter
npm test                        # Vitest — the unit/integration suite
npm run test:browser            # loads the extension in real Chromium, English article
PAGE=zh npm run test:browser    # same checklist against a Chinese article

node build.mjs                  # builds both targets to dist/chrome and dist/firefox
```

See [`CLAUDE.md`](CLAUDE.md) for repository conventions and current file map before making
changes, and [`alcoia/README.md`](alcoia/README.md) for the extension's own configuration and
keyboard-shortcut reference.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Security

Found a vulnerability? Do not open a public issue — see [`SECURITY.md`](SECURITY.md) for how to
report it privately.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

## License

The extension client is **[AGPL-3.0](LICENSE)**. Fonts bundled under `alcoia/src/libs/` are SIL
OFL 1.1; other bundled third-party code is permissive-licensed. The API server is a separate
program in a separate private repository and was never covered by this grant. Full scope and
attributions: [`NOTICE.md`](NOTICE.md).
