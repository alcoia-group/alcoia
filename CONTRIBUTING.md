# Contributing

Read this before opening an issue or a pull request — it will save you time either way.

## The honest starting point

This repository is public for transparency and verification, not because it's actively looking
for contributors (see [`README.md`](README.md#why-only-the-extension-is-public)). Issues and pull
requests are read, but they are not actively triaged on a schedule, and an unsolicited pull
request — even a good one — is not likely to be merged quickly, if at all. That's not a
reflection on the contribution; it's a statement about how much maintainer time exists right now.

If that's fine with you, the rest of this file is real and current. If you were hoping for an
actively-maintained-by-committee project, this isn't quite that yet.

## Reporting bugs

Open a GitHub Issue. Include:

- What you expected to happen and what actually happened
- Browser and version (`chrome://version`)
- Steps to reproduce, ideally on a real page you can name or link
- Whether it reproduces with a fresh, unmodified profile — narrows down whether another
  extension or a local setting is involved

**Do not** file a security vulnerability as a public issue — see [`SECURITY.md`](SECURITY.md).

## Suggesting features

Also a GitHub Issue, labelled as a feature request if that label exists. State the problem you're
trying to solve before the solution you have in mind — the product has fairly specific opinions
about what it will and won't do (see [`CLAUDE.md`](CLAUDE.md) §1, "Decisions — do not
re-litigate"), so a suggestion that lands on an already-settled question will likely be closed
with a pointer to that section rather than a lengthy debate.

## Submitting a pull request

1. **Branch naming**: `fix/short-description` or `feature/short-description`. Doesn't need to be
   clever, needs to be findable in a branch list six months from now.
2. **Commit messages**: describe *why*, not just *what* — a message that says "fix bug" is not
   useful in `git log` a year later. Look at recent commit history in this repo for the tone.
3. **Tests**: a behavior change needs a test that would have failed before it and passes after.
   Run the full suite before opening the PR:
   ```bash
   npm run lint && npm test
   npm run test:browser            # if you touched anything user-facing
   ```
   A change that reduces the passing test count needs an explanation in the PR description, not
   a silently adjusted assertion.
4. **Scope**: one thing per PR. A PR that mixes an unrelated refactor with the actual fix is
   harder to review and more likely to sit unreviewed.

## Code style

[`CLAUDE.md`](CLAUDE.md) is the actual style guide and repository map for this project — read it
before writing code, not after review comments ask you to. It covers module conventions, the
signal/detector registration pattern, storage-key naming, and the product's hard invariants
(§4), several of which are enforced by tests, not just convention.

## What happens to your contribution

Anything merged into this repository is licensed under **AGPL-3.0**, the same license as the rest
of the extension client (see [`LICENSE`](LICENSE)). By opening a pull request, you're agreeing
your contribution is offered under that license. There is no separate CLA.

## What not to contribute

A few things will be declined regardless of how well they're implemented, because they conflict
with hard product invariants (see `CLAUDE.md` §4):

- **Anything that reintroduces camera or webcam access.** The gaze-tracking path was removed
  deliberately, not left unfinished — no `getUserMedia` call belongs anywhere in this codebase,
  and `npm run test:browser` (`tests/browser/smoke.mjs`) guards against it coming back with a
  real trip-wire on `getUserMedia` in a live browser, not just a source-text grep.
- **Anything that sends reading content, user data, or usage data off-device without explicit,
  visible disclosure at the point it happens.** The one existing exception — passage text sent to
  generate a question or explanation — is documented everywhere it applies; a new one needs the
  same treatment, not a quiet addition.
- **Any accuracy claim, percentage, or benchmark figure**, anywhere — code, comments, UI copy, or
  docs. See `CLAUDE.md` §6 for why; the short version is that every figure that has ever existed
  for this project came from synthetic data and has since been retracted.
- **Covert or silent monitoring of any kind** — no hidden mode, no admin override that observes a
  reader without an action of theirs triggering it.

An issue or PR proposing one of the above will likely be closed with a link to this section rather
than a lengthy back-and-forth — not to be dismissive, but because these are already-settled
questions, not open ones.
