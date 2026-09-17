<p align="center">
  <img src="alcoia/assets/alcoia-wordmark-cream.png" width="440" alt="alcoia">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="License: AGPL-3.0"></a>
  <img src="https://img.shields.io/badge/version-0.2.0--pre--release-lightgrey.svg" alt="Version 0.2.0 (pre-release)">
</p>

alcoia is a browser extension that notices when a reader has stopped following a page and asks a
short question about the passage instead of summarizing it. It does not use a camera, does not
track eye movement, and does not build a profile of what you read. It is for anyone reading long
material online who wants to retain it: students, researchers, habitual skimmers. The client is
open source so the privacy claim above can be checked against the code, not taken on trust.

## Install

**Chrome Web Store:** not published yet.

**Load unpacked, for development or to inspect the code:**

```bash
git clone <this repo>
cd alcoia
npm install
```

Open `chrome://extensions`, enable Developer mode, and Load unpacked pointing at the `alcoia/`
directory.

## Build and test

```bash
npm run lint && npm test
npm run test:browser
PAGE=zh npm run test:browser
node build.mjs
```

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how detection, the state engine, and the
interruption budget fit together.

## Privacy

Published at [alcoia.app/privacy](https://alcoia.app/privacy).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Security

See [`SECURITY.md`](SECURITY.md).

## Code of conduct

See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## License

The extension client is [AGPL-3.0](LICENSE). Third-party components are listed in
[`docs/NOTICE.md`](docs/NOTICE.md).
