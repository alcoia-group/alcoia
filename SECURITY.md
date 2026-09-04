# Security Policy

This repository is public for transparency and verification (see the "About this repository"
section of `README.md`). It does not solicit external contributions, but a private channel to
report a security issue is needed regardless — filing a vulnerability as a public GitHub issue is
not appropriate for a product that handles reading data and is sold to institutions.

## Reporting a vulnerability

<!-- TODO(owner): fill in a real reporting contact before this file is relied on. Do not report a
     vulnerability to any address below until this TODO is resolved — none of it is live yet. -->

**Report to:** TODO — a security contact email or a private reporting form.

**Scope:** see "What is in scope" / "What is out of scope" below.

**Response time:** TODO — an acknowledgement SLA (e.g. "within N business days") once the owner has
committed to one. Do not invent a number here.

**Disclosure:** TODO — the owner's preferred coordinated-disclosure timeline, if any.

## Recommendation for the owner

<!-- TODO(owner): consider enabling GitHub's private vulnerability reporting for this repository
     (Settings → Security → Private vulnerability reporting). It gives reporters a structured,
     private channel without requiring a separate email address to staff, and integrates with
     GitHub Security Advisories for coordinated disclosure. -->

## What is in scope

- The browser extension client in this repository (Chrome MV3 / Firefox build targets).

## What is out of scope

- The API server. It lives in a separate private repository — see `CLAUDE.md`'s "Scope" section —
  and a report about it should go through that repository's own channel once one exists, not this
  file.
- Findings that require the AGPL-3.0-licensed CLAUDE.md defect list already published in this repo
  — those are known and tracked, not undisclosed vulnerabilities.
