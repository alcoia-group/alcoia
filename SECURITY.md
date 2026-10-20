# Security policy

Report vulnerabilities privately. Do not open a public issue.

## How to report

1. Use GitHub's private vulnerability reporting: go to the repository's **Security** tab and choose **Report a vulnerability**.
2. If you cannot use GitHub, email hello@alcoia.app with "Security" in the subject line.

Include the affected file or feature, the browser and version, steps to reproduce, and what an attacker could do with it.

## Scope

In scope: the browser extension in this repository (Chrome and Firefox builds).

Out of scope:

- The API server, which is a separate private project. If you find a server issue, send it through the same channels above and we will route it.
- Issues in third-party code under `alcoia/src/libs/`. Report those upstream (see [`docs/NOTICE.md`](docs/NOTICE.md)).
