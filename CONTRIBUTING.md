# Contributing

Issues and pull requests are welcome. Maintainer time is limited, so review can be slow, and a pull request may be declined if it conflicts with the product's design (see "What not to contribute"). The API server is a separate private repository (see the Scope table in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)).

## Reporting bugs

Open a GitHub Issue. Include:

- What you expected to happen and what actually happened
- Browser and version (`chrome://version`)
- Steps to reproduce, ideally on a real page you can name or link
- Whether it reproduces with a fresh, unmodified profile, which rules out another
  extension or a local setting

Do not file a security vulnerability as a public issue. See [`SECURITY.md`](SECURITY.md).

## Suggesting features

Open a GitHub issue with the feature request template. Describe the problem before the solution. Some questions are already settled by the hard invariants in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), and a suggestion that conflicts with them will be closed with a link to that section.

## Submitting a pull request

1. **Branch naming**: `fix/short-description` or `feature/short-description`. Doesn't need to be
   clever, needs to be findable in a branch list six months from now.
2. **Commit messages**: describe *why*, not just *what*. "Fix bug" tells a future reader nothing. Look at recent commit history in this repo for the tone.
3. **Tests**: a behavior change needs a test that fails without it. Run the suite before opening the PR:
   ```bash
   npx eslint . && npm test
   npm run test:browser            # if you touched anything user-facing
   ```
   A change that reduces the passing test count needs an explanation in the PR description, not
   a silently adjusted assertion.
4. **Scope**: one thing per PR. A PR that mixes an unrelated refactor with the actual fix is
   harder to review and more likely to sit unreviewed.

## Code style

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the repository map and lists the product's hard invariants and conventions. Read it before writing code. Several invariants are enforced by tests. Run `npx eslint .` before opening a pull request.

## What happens to your contribution

Anything merged into this repository is licensed under **AGPL-3.0**, the same license as the rest
of the extension client (see [`LICENSE`](LICENSE)). By opening a pull request, you're agreeing
your contribution is offered under that license. There is no separate CLA.

## What not to contribute

These conflict with the hard invariants in `docs/ARCHITECTURE.md` and will be declined however well they are implemented:

- **Camera or webcam access.** No `getUserMedia` call belongs in this codebase. `npm run test:browser` (`tests/browser/smoke.mjs`) fails if one runs in a live browser.
- **Sending reading content, user data or usage data off the device without visible disclosure at the point it happens.** Passage text sent to generate a question or explanation is documented wherever it applies. A new case needs the same documentation.
- **Accuracy claims, percentages or benchmark figures** in code, comments, UI copy or docs. See "Claims discipline" in `docs/ARCHITECTURE.md`.
- **Covert monitoring**: no hidden mode and no override that observes a reader without an action of theirs.
