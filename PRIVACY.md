# Privacy policy — alcoia

The published privacy policy is at **[alcoia.app/privacy](https://alcoia.app/privacy)**. That page
is the current, authoritative statement of what the extension collects, what it does not, and how
each data flow works.

This file used to be an internal scaffold for drafting that policy, with every section marked
`TODO(human)`. It is no longer needed for that purpose and has been reduced to this pointer; the
earlier draft, including its code-derived notes on each data flow (receipts, highlights, the quiz,
free-text answer grading), is still in this repository's git history if it's useful as engineering
reference.

For the mechanism-level detail behind the policy (what stays local, what's transmitted and why, the
hard invariants the code enforces), see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Ideas noticed on web pages (on this device only)
On ordinary web pages the extension keeps a short list of ideas that came up repeatedly (at most 400 labels) with counts of questions you answered right and wrong about them, so it can ask less about what you know and explain what you keep missing. It is stored in the browser's local storage, is never sent to alcoia or anyone else, is not synced, contains no page address, title or text, and can be cleared from the diagnostics page. (Wording for the owner and counsel to confirm.)
