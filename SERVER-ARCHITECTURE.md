# alcoia server — architecture

**Add to:** the server repo root (`alcoiaServer/SERVER-ARCHITECTURE.md`).

**Note on status.** This document was originally written as a design ahead of implementation. S1–S8
are now built, and the implementation **corrected the design in several places**. Where they differ,
the built code is right and this document records both the decision and the correction, so nobody
re-derives the original guess.

Read `the project notes` first for invariants, and `ALCOIA-PLATFORM-SPEC.md` for the product rules this
serves.

---

## 1. Scope

**Is:** accounts, entitlements, seats, assignments, anonymous aggregation, and a proxy to a language
model.

**Is not** a record of what people read. Most of the design exists to make that structurally true
rather than a policy promise.

### What is stored

| Stored | Not stored |
|---|---|
| Accounts: email, auth credential, plan | Reading history for any individual |
| Install tokens (hashed) and call counts | Which pages a reader visited |
| Orgs, org memberships, classes, seats, invites | Highlights, notes, quizzes — these stay on the device |
| Assignments, salts, uploaded documents | Passage text outside the generation cache |
| Outcome rows keyed by assignment pseudonym | Any client-supplied pseudonym |
| Receipt submissions (student-initiated only) | Anything for a free reader beyond a token and a count |

**Two honest qualifications.** State these rather than letting an auditor find them:

- **Assignment documents are stored.** Instructors upload deliberately. alcoia is a content host for
  that material.
- **The generation cache holds passage text transiently**, keyed by content hash, unattributed,
  24 hours, in memory only.

---

## 2. Stack

**Node ES modules + Express 4**, no TypeScript, no build step. **PostgreSQL** via
`node-pg-migrate` with plain-SQL migrations — chosen so constraints and triggers read as exactly
what runs. **Vitest**. **No ORM**: thin per-table repositories with hand-written parameterised SQL.

**Business logic in dependency-free pure modules** taking plain data and returning plain data — no
pool handle, no HTTP objects. Rate-limit math, span validation, cohort aggregation and receipt
signing are all unit-testable without a server or a database. This is the most important convention
in the repo.

**Runtime dependencies beyond Express and `pg`:** `node-pg-migrate`, `@aws-sdk/client-s3`,
`@aws-sdk/s3-request-presigner`, `jose`. Nothing else, and nothing added without asking. `jose` was
proposed against hand-rolling on `node:crypto` alone and confirmed before adding it (§12's LTI
section has the reasoning) — RS256/JWKS verification with the algorithm pinned, plus the tool
signing its own JWTs for NRPS and deep linking, is a materially larger crypto surface than the
single-algorithm, no-remote-key-material HMAC/opaque-token primitives this codebase otherwise
hand-rolls.

**External services behind provider interfaces**, each with a dev fallback that refuses to activate
in production and a hard boot failure if a production credential is missing:

- `src/ai/index.js` → Groq
- `src/email/index.js` → Postmark
- `src/storage/index.js` → Cloudflare R2 / S3-compatible
- `src/billing/index.js` → Creem (§13)

The provider abstraction is not tidiness — Institution-tier self-hosting depends on it existing.

**Canvas (LTI) is not shaped this way, deliberately.** There's no "dev fallback" Canvas provider —
without `LTI_TOOL_PRIVATE_KEY`, `src/app.js` simply never mounts the LTI router at all, the same way
a signing key with no fallback (`RECEIPT_SIGNING_SECRET`) works, not the way a skippable-in-dev
credential (Groq/Postmark/storage) works. Most deployments have no Canvas customer yet; LTI is
Institution-tier-only infrastructure, not a path every environment needs to boot through.

**Every credential this server issues is hashed at rest.** Install, magic-link, session and invite
tokens are random opaque strings stored only as SHA-256. A database read alone never yields a usable
credential.

**Integrity in the schema where it is concurrency-sensitive.** Seat capacity and the reporting-mode
lock are Postgres triggers using `SELECT ... FOR UPDATE`. An application-level check-then-insert
cannot close that race.

### Design corrections made during implementation

| Original design | Built | Why |
|---|---|---|
| `/v1/tokens`, `Authorization: Bearer` | `/api/token`, `X-Alcoia-Install-Token` | The shipped extension already calls this. **Match the client that exists**, not the brief. This became the convention for every later endpoint |
| No org-level roles | `org_memberships` added | The brief said "memberships" but S1 built only class seats. Org-level admin/instructor authorization, independent of any class seat, was genuinely missing |
| Signal 5, "time relative to difficulty" | Dropped | Nothing in the outcome payload or codebase measures either value. Building it would mean inventing data collection nobody asked for |
| Span stored with each question | Ephemeral 24h in-memory `question_id → span` map | A failure-rate entry can cite its evidence without persisting passage text |

---

## 3. Hosts

| Host | Purpose |
|---|---|
| `alcoia.app` | Marketing |
| `console.alcoia.app` | Admin console |
| `api.alcoia.app` | This server |

`.app` is HSTS-preloaded, so HTTPS is enforced at the browser level.

---

## 4. Authentication

**Free: install token, no account.** `POST /api/token` issues an opaque, hashed-at-rest token.
Issued, never derived. Issuance is rate-limited **per IP** — the hard bottleneck against scripted
farming. If ever exploited, add proof-of-work there rather than adding identification anywhere.

**Never log a token alongside passage content.**

**Anomaly revocation revokes the token, not the reader.** The shipped client treats 401/403 as
"clear and reissue", so a false positive self-heals. This is why *issued* beats *derived* — you can
kill a token, you cannot kill a fingerprint.

**Paid: accounts, magic link.** Short-lived single-use links; three session kinds — a short
`console` session, a longer-lived `extension` credential, and `lti` (§12, Canvas launches only).
`password_hash` and `auth_method` exist in the schema, unused, so adding passwords later is a
feature rather than an emergency migration.

`GET /api/entitlements` returns `{ tier, features[], expires }`, resolving subscription → seat →
free. It **never errors on a missing credential** — "not logged in" and "free tier" are the same
answer here. The subscription branch reads `accounts.plan` / `accounts.plan_expires_at` — §13
(billing) is the first thing that ever writes those columns to a real value; `src/entitlements/
resolve.js` itself needed no change to "read from Creem-sourced state," since that's exactly what
it already did.

**Return `features[]`, not a bare tier name**, so the extension asks "may I do X" instead of
reimplementing the plan matrix. Adding a capability then needs no extension release.

**The client never decides.** There is no plan value in client storage that gates anything.

### The magic-link → extension-session handoff (open question 5, resolved)

Verifying an `extension`-kind link no longer mints the session directly — it mints a short-lived
(2 min placeholder), single-use, hashed-at-rest `extension_handoff_codes` row and returns **the
code**, not a credential, to whatever verified it. `POST /api/auth/extension-session/exchange` is
the only thing that turns a code into an actual `extension` session.

**Why:** verification happens on a web page; the credential it's requesting is for the extension —
a different, unrelated JS context with no access to that page's memory or storage. A 90-day
credential handed to a page to hold is the wrong shape regardless of transport. A code that's
worthless the moment it's used, or two minutes later, is not. `console`-kind verification is
untouched — that page *is* the console, so it still gets the session directly.

Exchange is rate-limited per IP (`extensionHandoffExchange`, a §5 placeholder) as defense-in-depth
on top of single-use consumption and the code's own entropy (32 random bytes, same as every other
opaque token here) — not because the code is realistically guessable.

**Two things this server cannot solve, stated rather than assumed away:**

- Getting the code from the verify response into the extension's hands is the landing page's job
  (console repo). It must never end up in a URL query string — that outlives a 2-minute TTL in
  server logs, browser history and `Referer` headers, in a way a JSON response body read once does
  not.
- If the link is opened in a browser/profile without the extension, or a different one than usual,
  there is no automatic bridge. The code just expires, unconsumed. A "clearly say the extension
  wasn't found" page and a manual copy-the-code fallback are both landing-page UX, not an API gap.

---

## 5. Rate limiting — four layers

| Layer | Limit |
|---|---|
| Token issuance | Per IP, hard |
| Per-token burst | Sliding window |
| Per-token ceiling | **120 calls/month** |
| Per-endpoint cost multiplier | Questions cost more than summaries |

Plus request size caps everywhere.

**Only 120/month and the 5-pseudonym cohort floor are final figures.** Every other threshold —
burst windows, anomaly cadence, session TTLs, storage quotas, cost weights — is an
environment-overridable placeholder marked as such, pending product approval.

**The extension also rate-limits itself** (burst 6/10s, ceiling 30/10min). That catches alcoia's own
loops and stuck handlers, which produce calls carrying a valid token that look legitimate. **It is
not a security control** — the extension is open source and the check is removable in a minute.
**Never assume the client's limiter ran.**

---

## 6. The pseudonym — the core privacy primitive

`src/pseudonym/derive.js`:

```
pseudonym = HMAC(assignment.salt, account_id)
```

Each assignment gets its own random 32-byte salt at creation, server-generated, never
client-supplied.

- **Stable within an assignment** — repeat visits count as one person, which is what makes "78% of
  the class" a statement about people rather than sessions.
- **Unlinkable across assignments** — different salts, so two assignments' rows cannot be joined
  even by someone holding the database.
- **No mapping table exists.** The link is a computation, not a row.
- **Deleting the salt makes future derivation permanently impossible** while every outcome row
  survives.

**Direction matters.** Everywhere except one place, the computation runs only `account_id →
pseudonym`. Identified mode is that one place, and it is honest about it: rather than reversing an
observed pseudonym, it derives *forward* from every account known to have held a seat in the class
and checks which matches. **The capability exists because the salt exists.** Nothing exposes it
except the feature explicitly designed to, and it is off by default.

**Retention.** `scripts/delete-expired-salts.js` runs on an external scheduler. 12 months after
close by default, org-configurable to a hard 24-month maximum. Anonymous classes only; identified
mode retains for the class lifetime by design.

**`outcomes.pseudonym` is deliberately not a foreign key.** `receipt_submissions.account_id` is
deliberately the opposite — a real FK — because a student choosing to submit their own receipt is
the one place per-student visibility is legitimate.

---

## 7. AI endpoints

`POST /api/questions`, `POST /api/summarize`.

### The span rule — load-bearing

**Every question must cite, verbatim, a sentence present in the passage.** Anything failing
validation is discarded; if nothing survives, 422 and the client falls back to an explanation. A
model that cannot point at its evidence invented the question, and an invented question asked of a
struggling reader is worse than none.

Validation logic was **ported, not rewritten**, from the extension's vendored contract snapshot.

**Do not weaken this for the difficulty ladder.** Recall and Explain have answers in the passage;
Connect, Apply and Challenge do not, by construction. The resolution is a **level-dependent span
role** — the span stays mandatory and verbatim everywhere, but anchors to the answer, the principle
being applied, or the claim being challenged, depending on level. See open question 1.

### Prompt construction

Passage wrapped in explicit `<<<PASSAGE>>> ... <<<END PASSAGE>>>` delimiters with an
injection-defence instruction. **Passage text and reader text occupy separate delimited fields,
never concatenated into instruction position.** The system prompt is fixed and never composed from
page content — the extension reads arbitrary, potentially hostile pages.

**No personality instruction to the model.** Every trace of the prototype's persona framing was
stripped. This is a safety boundary: an education product used by minors and sold to institutions
must not let the model improvise.

**Output must be a constrained shape.** Anything else resolves to `unknown` on the client, and
`unknown` never interrupts. Never parse free-form model prose into a verdict.

Content-hashed 24h in-memory cache. Nothing not already public is sent to Groq.

---

## 8. Orgs, classes, seats, invites

`org_memberships` carries org-level admin/instructor authorization independent of class seats.

Seat capacity (instructor seats free and uncounted) and the reporting-mode lock (a class can never
change mode once a student has joined) are **Postgres triggers with row-level locking**, proven
under a genuine two-transaction concurrency test.

Invites carry mode (`domain` / `open`), `max_joins`, a required `expires_at`, and revocability.

---

## 9. Documents

Cloudflare R2 via the S3 SDK — free tier, no egress fees, which matters because documents are served
through short-lived signed URLs rather than proxied. Raw body upload via Express's built-in parser,
no `multer`.

`documents.status` honestly reports only PDF as `accepted`. PPTX and DOCX upload but are
`unsupported` — no extraction pipeline exists.

**Genuine deletion:** the object is removed from storage *before* the row is touched, verified by a
test that fetches the object afterward.

**Authorization is class-scoped.** An early draft used "does this account hold any active seat
anywhere", which would have leaked documents cross-org.

---

## 10. Aggregation

`POST /api/assignments/:id/outcomes` derives the pseudonym server-side. **A client-supplied
pseudonym is never read** — it could be forged or replayed to skew a class aggregate, and an
instructor makes teaching decisions from that aggregate.

`GET /api/assignments/:id/aggregate` computes, in a pure module: trouble map, **separately
addressable** confidently-wrong signal, per-question failure rates, abandonment histogram, and
completion paired with comprehension.

**Minimum cohort floor: 5 distinct pseudonyms**, enforced on every per-paragraph and per-question
figure, in the API rather than the console. Not applied in identified mode.

---

## 11. Receipts

`POST /api/receipt/sign`, `/verify`, `POST /api/assignments/:id/receipts`.

HMAC-SHA256, ported near-verbatim from the extension's vendored contract module. **Sign and verify
are structurally incapable of storing anything** — neither function takes a database handle.

Every response says **"unaltered since issued"**. Never "verified", never "authentic".

Submission is gated behind an explicit `studentConfirmed: true` flag — never inferred, never
available to an instructor requesting on a student's behalf.

`receipt_submissions.lti_resource_link_id` (nullable) tags a submission with the Canvas resource
link it came through, when there is one — see §12.

---

## 12. LTI 1.3 / Canvas (Institution tier)

`src/http/routes/lti.js`, `src/lti/*`. alcoia is the tool; Canvas is the platform. Full reasoning,
including the AGS/grade-passback refusal and the pseudonym-derivation confirmation, is in
the project notes' "Implemented (S10)" note — this section is the architecture summary, that one is the
product-rules record.

**Launch** is OIDC third-party-initiated login (`POST /api/lti/login` → Canvas → `POST /api/lti/
launch`). `lti_launch_states` holds a hashed, single-use `state`/`nonce` pair per attempt (same
shape as `extension_handoff_codes`). Three independently-rejectable checks at launch, in order:
state (CSRF/replay of the login round-trip itself), signature (`jose.jwtVerify` against the
platform's JWKS, `algorithms: ['RS256']` pinned explicitly), nonce (the id_token's own `nonce` claim
must match what this specific state was issued with, catching a captured id_token replayed against
a *different*, fresh login attempt — a distinct failure mode from a bare state replay).

**A third session kind, `lti`** (`sessions_kind_check`), structurally unable to pass
`requireSession(pool, { kind: 'console' })` — every org/class/invite management route — regardless
of what role Canvas's launch claims. Console administration stays reachable only via magic link.

**The reporting-mode disclosure is a server-side gate for LTI specifically**, because unlike the
native invite path (a console screen shown before any seat exists), Canvas's launch has no
equivalent checkpoint. A fresh seat's `disclosure_ack_at` is null; an unacknowledged student launch
returns a short-lived, single-use ack code (`lti_pending_launches`) instead of a session.
`POST /api/lti/disclosure/ack` requires `acknowledged: true` explicitly before minting one.

**Identity mapping is new columns, not new tables for the common case:**
`accounts.external_id`/`external_source` and `classes.external_id`/`external_source`, both with a
partial unique index (`WHERE external_source IS NOT NULL`) so non-LTI rows never collide. A class
only gets an external identity through deep linking (requires an already-existing, already-staffed
Institution-tier class) — a resource-link launch for an unprovisioned context is a `404`, never an
auto-create.

**Roster sync (NRPS)** is console-triggered (`POST /api/classes/:id/lti/roster-sync`), not
scheduled — there's no in-process scheduler in this codebase to attach it to. Reconciliation is a
pure module (`src/lti/roster-sync.js`): diffs a fresh roster against active, LTI-originated seats
only (a seat with no external identity — joined natively — is never touched). "Dropped" is absence
from the roster response, not a status field. The membership URL itself is a per-launch claim, not
a fixed platform property, so it's captured on first sight (`classes.lti_nrps_url`) and reused.

**Deep linking** shares the launch endpoint, dispatched on `message_type`. It lets an instructor
attach an existing alcoia assignment (created via the console, same as always) from inside Canvas.
The signed Content-Items response is produced here; POSTing it to Canvas's `deep_link_return_url` is
console UI work, same division as the magic-link handoff.

**No AGS.** `tests/lti/no-ags.test.js` walks the real registered Express routes and asserts none are
grade/lineitem/submission-status shaped, so this can't quietly regress.

**Known simplifications:** one `lti_platforms` row assumed per (issuer, client_id); NRPS reads a
single response page, no RFC 5988 pagination; no rate limiting on the LTI endpoints themselves yet
(single-use consumption and code entropy are the current guard, matching the reasoning already
accepted for `extensionHandoffExchange` — but that specific layer wasn't added here).

---

## 13. Billing (Creem)

`src/billing/*`, `src/http/routes/billing.js`. the project notes §12 lists "anything touching payments" as
requiring explicit human approval before proceeding — this was built under exactly that, an explicit
repo-owner instruction treated as the approval, recorded rather than assumed (the project notes' §11
"Implemented (S11)" note has the full record).

**Checkout sends a plan key, never a price.** `POST /api/billing/checkout` accepts `'reader'` or
`'student'` and resolves the Creem `product_id` server-side (`src/billing/plans.js`) — a
client-supplied `product_id` or `price` field is never read, not merely rejected.

**The webhook is the only source of truth.** `POST /api/billing/webhook` verifies an HMAC-SHA256
signature over the exact bytes Creem sent (`src/billing/webhook-signature.js`) before touching
anything — `express.json()`'s `verify` hook (`src/app.js`) captures those raw bytes onto
`req.rawBody` specifically so a route-scoped raw-body parser isn't needed and can't lose the race
against the global JSON parser for a `Content-Type: application/json` request. Only a verified
event ever calls `grantSubscription`/`revokeSubscription` (`src/accounts/repository.js`).
**Checkout's success redirect grants nothing** — the redirect target polls `GET /api/entitlements`
until the webhook lands. Commented at both routes; getting this backwards is, per this item's own
research, the single most-reported Creem integration bug.

**Idempotency via a UNIQUE index, inserted before any grant.** `billing_webhook_events (provider,
event_id)` — a conflict means "already processed," acknowledged the same as first delivery,
entitlement untouched. Same insert-is-the-lock shape as `invites.joins_count` and LTI's launch-state
consumption (§12).

**A real S1 bug, found and fixed here:** `accounts.plan`'s `CHECK` only allowed `orgs.tier`'s
vocabulary (`pilot`/`teams`/`institution`), never exercised since nothing wrote to it before this
item. Fixed to `'reader'`/`'student'` — the project notes' §11 note has the full account.

**Events handled:** `subscription.active` (created) and `subscription.paid` (renewed) both grant;
`subscription.canceled` and `subscription.expired` both revoke immediately; `subscription.
payment_failed` is a deliberate no-op (Creem's own retry handles it); anything else is a safe no-op.
Full table and reasoning in the project notes' §11 note, including the flagged product-choice-not-bug of
revoking on cancellation immediately rather than at period end.

**Flagged rather than assumed correct:** the webhook signature header name, the exact event type
strings, and the Creem checkout/portal endpoint shapes in `src/billing/creem-provider.js` were
implemented without live access to re-confirm them against current Creem docs — each is commented
at its point of use. `src/billing/parse-webhook-event.js` isolates every such guess into one
function so a correction stays a small diff.

---

## 14. Testing

- **Pure modules tested directly**, no server or database.
- **Route tests run the real Express app against fake in-memory pools** whose `query(sql, params)`
  pattern-matches the literal SQL each repository issues, including reproducing the S5 triggers in
  JavaScript. Deliberately closer to the real path than mocking repositories — and it caught two
  real bugs a repository mock would have hidden, including a camelCase/snake_case mismatch whose own
  unit test passed because the fixture was wrong in the same way as the code.
- **Real-Postgres integration tests** under `tests/db/`, `describe.skipIf(!databaseUrl)`.

⚠️ **No `tests/db/*` run has happened.** 64 tests written, believed correct, never executed against
a live database — including the two-transaction seat-capacity concurrency test, which guards the
thing you bill on. **This is the top pre-merge item**, and now also covers the LTI tables' triggers
(`ALC04`, external-identity uniqueness), the `lti`-kind session check, the fixed `accounts.plan`
constraint, and `billing_webhook_events`' idempotency guarantee.

---

## 15. Open questions

1. **Difficulty ladder above Explain** — needs the level-dependent span role.
2. **Free-text model-scored answers** — would make an LLM output the ground truth for
   comprehension. Needs grader authority resolved and a data-flow disclosure.
3. **Pilot abuse** — many small free orgs instead of one paying one.
4. **Data residency** — affects hosting region and the sub-processor list.
5. **PPTX and DOCX extraction pipelines.**

**Resolved since this list was written:** magic link → extension session handoff (was item 5) —
see §4.