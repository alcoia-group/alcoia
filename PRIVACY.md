# Privacy Policy — alcoia

> **⚠️ SCAFFOLD ONLY — NOT PUBLISHABLE, NOT A PRIVACY POLICY YET.**
>
> Every section below is a `TODO` for a human. This file exists so the structure and the
> questions are in one place; the answers are not here. Generated privacy text reads
> plausibly and is wrong about actual data flows, which is worse than having no file —
> a policy that misdescribes what the extension does is a false statement to users and to
> the Chrome Web Store, not a formality.
>
> **Do not publish this. Do not link it from the Web Store listing. Do not let an agent
> fill it in.** See `the project notes` § "Requires human approval".
>
> Chrome Web Store requires a reachable privacy policy URL for any extension requesting
> camera access. This file becoming real is a P0 blocker for shipping.

---

## 1. Who we are

`TODO(human)` — Legal entity or individual name, jurisdiction of establishment, contact
address, and a working contact email. Required by GDPR Art. 13(1)(a) if any EU user is in
scope.

## 2. What the extension collects

`TODO(human)` — Enumerate, per category, from the code rather than from intent.

Starting points observed in the codebase during the P0 audit. **Each needs verification
before it goes into a published policy — treat these as leads, not findings:**

- Text of the paragraph a reader is on is sent to the backend when an AI response is
  triggered (`POST /api/summarize`). Confirm exactly what fields accompany it.
- Reading-speed baseline and highlight state are persisted via `chrome.storage`. Confirm
  whether that is `storage.local` (device only) or `storage.sync` (replicated through the
  user's Google account) — the answer changes what has to be disclosed.
- Webcam frames are processed in-page by WebGazer. Confirm and state plainly that no
  frame, no still image, and no derived image data leaves the device — this is a hard
  invariant in `the project notes` and should be verifiable by a reader from the network panel.
- Confirm what, if anything, the backend logs — including whether paragraph text appears
  in request logs, and for how long.
- **New as of the quiz feature:** `chrome.storage.local` also now briefly holds selected
  paragraph text (`sra_quiz_pending`) for the one call to generate a quiz's questions, cleared
  once the quiz page reads it. The quiz record itself, in IndexedDB, holds only the generated
  questions (including each one's `span` — a single verbatim sentence cited as the answer's
  evidence, not the paragraph it came from), the reader's chosen answers, and their confidence
  ratings — no paragraph text, no page title, no URL beyond a hostname+pathname key. Confirm
  this against the actual code (`src/content/quiz-store.js`, `src/content/content.js`'s
  `runQuiz()`) before it goes in a published policy, same as every other line here.

## 3. What is not collected

`TODO(human)` — State the negatives explicitly, but only the ones actually enforced in
code. An unverified negative claim here is the most dangerous sentence in the document.

## 4. Camera

`TODO(human)` — Cover: camera is off by default and requires explicit opt-in; what gaze
data is derived; that raw gaze coordinates are never persisted or transmitted (aggregates
only); how to revoke; what happens to stored calibration on revocation.

## 5. Third parties

`TODO(human)` — The backend proxies to Groq. Disclose the sub-processor by name, what is
sent to it, where it is processed, its retention policy, and link its terms. Check
whether Groq's current terms permit the intended use and whether they train on submitted
content.

## 6. Legal basis and retention

`TODO(human)` — GDPR Art. 6 basis per processing purpose. Retention period per category.
Deletion mechanism and how a user invokes it.

## 7. User rights

`TODO(human)` — Access, rectification, erasure, portability, objection; how to exercise
each; supervisory authority complaint route.

## 8. Children

`TODO(human)` — Consequential if alcoia is pitched at schools or universities. COPPA
(US, under 13) and any applicable local equivalents. If institutional pilots happen, this
section and a DPA both become blockers, not niceties.

## 9. Changes to this policy

`TODO(human)` — Notification mechanism and effective date.

---

## Open questions to resolve before writing any of the above

1. Does the backend log request bodies? If yes, paragraph text is retained server-side and
   §2 and §6 must say so.
2. `chrome.storage.local` or `chrome.storage.sync`? Sync means data leaves the device.
3. **The receipt exists now (P4) and needs covering.** Verified behaviour, still to be
   written up by a human: it is built only when the reader presses Alt+I or triggers it
   from the popup; the full contents are shown before any copy, download or sign action;
   it contains a hash of the URL rather than the URL; `auditReceipt()` refuses raw sensor
   fields. The only thing that leaves the device is a signing request the reader clicks,
   which returns the receipt and stores nothing server-side. If receipts are ever shared
   with an institution, that is a disclosure and probably needs a DPA.
4. Is there a paid tier with accounts? Then billing data, auth identifiers, and the
   payment processor all need covering — and `the project notes` requires human approval for
   anything touching payments or PII.
5. Which jurisdictions are in scope at launch? Determines whether GDPR, UK GDPR, CCPA, or
   several apply.
