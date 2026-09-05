# alcoia — platform specification

**Add to:** the server repo root (`alcoiaServer/ALCOIA-PLATFORM-SPEC.md`).

**Who this is for.** Anyone picking up alcoia's server, console or commercial work without having
been in the conversations that produced it. It states what is being built, and where the reason is
not obvious, why — because decisions without reasons get reversed by the next person.

Decisions are settled unless marked **OPEN**.

---

## 1. What alcoia is

A browser extension that notices when a reader is struggling with a page and asks a retrieval
question about what they just read.

**Its purpose is to make the reader need it less.** Declining intervention need is success. This is
not a slogan; it decides technical questions. A correct answer ends with a tick and nothing else,
because explaining a correct answer adds load at the moment of consolidation. There is no XP,
streak, leaderboard or confetti, because engagement mechanics optimise for the opposite of
independence.

If a proposed feature increases engagement at the cost of the reader's self-sufficiency, it is
wrong for this product regardless of how well it would perform.

---

## 2. The plans

| | Free | Reader / Student | Teams & Classrooms | Pilot | Institution |
|---|---|---|---|---|---|
| Account required | No | Yes | Yes | Yes | Yes |
| Reading detection, interruptions | ✅ | ✅ | ✅ | ✅ | ✅ |
| Retrieval questions | ✅ | ✅ | ✅ | ✅ | ✅ |
| Confidence capture | ✅ | ✅ | ✅ | ✅ | ✅ |
| Quiz (local, per document) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Highlights, notes, session recall (local) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Reading guide, dark mode, dyslexia tint, snooze | ✅ | ✅ | ✅ | ✅ | ✅ |
| **PDF / PPTX / DOCX assistance** | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Reading receipts** | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Cross-device sync** | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Aggregate class view** | ❌ | ❌ | ✅ | ✅ | ✅ |
| **Assigned readings** | ❌ | ❌ | ✅ | ✅ | ✅ |
| **Receipt submission** | ❌ | ❌ | ✅ | ✅ | ✅ |
| Admin console | ❌ | ❌ | ✅ | ✅ | ✅ |
| SSO | ❌ | ❌ | ✅ | ❌ | ✅ |
| DPA | ❌ | ❌ | ✅ | ❌ | ✅ |
| LTI / LMS integration | ❌ | ❌ | ❌ | ❌ | ✅ |
| Self-hosted backend, procurement, onboarding | ❌ | ❌ | ❌ | ❌ | ✅ |

**Reader and Student are one entitlement.** Student is a price verified at checkout, not a
capability. The server and extension know one tier, not two — two names for identical capabilities
is how divergence starts.

**Teams:** 25 seats minimum. **Pilot:** free, under 25 students. Instructor seat free and uncounted
on both.

### The free/paid principle

**Free improves the reading you are doing now. Paid keeps it.**

Free gets the full intervention loop including retrieval questions — the most expensive call alcoia
makes. Deliberate: a crippled free tier contradicts the mission visibly, and removes the reason
anyone would want the paid version.

Paid gets the three things about *keeping*: your own documents, a portable receipt, your data on
more than one machine.

**Be honest that PDF gating is packaging, not cost.** A PDF page costs no more to process than a web
page. It is gated because it is a different job — your coursework rather than the internet — and
because it took real work to build. That is legitimate. A cost story would not survive the obvious
question.

**Free readers' PDFs open in the browser's own viewer, not alcoia's.** Replacing someone's PDF
viewer with one that then refuses to help them is worse than not replacing it. This also removes any
need for paywall handling on the document surface.

---

## 3. Statefulness — level B

| Level | Server holds | Status |
|---|---|---|
| A | Nothing | Superseded |
| **B** | **Accounts, entitlements, tokens, counters, assignment aggregates** | **Current** |
| C | Above plus per-reader reading history | **Not approved** |

**The server never holds a record of what an individual read.** Highlights, notes, quizzes and
reading history live on the reader's device and are never transmitted.

This forbids, and these keep returning under new names:

- Cross-document concept maps, "a map of what you know"
- Per-concept knowledge state across time
- The **Connect** rung of the question ladder ("how does this relate to yesterday's reading?")
- Longitudinal quieting — adapting thresholds to competence over months
- Spaced review, spaced retrieval, next-day recall, vocabulary lists with review
- "Is this student improving over the term"

All need the same thing: a persistent record of an individual's reading. If that decision is
revisited it must be revisited explicitly, with the legal and trust consequences on the table — not
arrived at by building one feature that happens to need it.

**Local persistence is not level C.** Level B constrains what the company holds.

---

## 4. Access control

**Free tier: no account.** An opaque **install token**, issued on first run, carried on every AI
call. No token, no response.

The token is **issued, never derived** — not computed from IP, browser or device characteristics.
The reader can delete it and deleting it works.

**Fingerprinting is refused.** Not a preference, an invariant. A mechanism whose only purpose is to
defeat an action the reader deliberately took is covert monitoring. It is also a Web Store rejection
risk and a GDPR problem, and it is trivially defeated anyway.

**The reinstall leak is accepted.** One person, manually, monthly. The token exists to stop an
unauthenticated endpoint being scripted as a free LLM proxy by someone who never installs the
extension — that is the threat that produces a bill.

**Free ceiling: 120 AI calls/month.** No running counter, no "N remaining", no upgrade nag. **One
clear notice at the boundary** — a product that stops working with no explanation is broken, not
private. The diagnostics page is the one place the number appears.

**Paid tiers: accounts**, magic link. Cross-device sync, receipts and seat membership need one.

---

## 5. Infrastructure

| Host | Purpose |
|---|---|
| `alcoia.app` | Marketing site |
| `console.alcoia.app` | Admin console — instructors and admins, all tiers |
| `api.alcoia.app` | The API |

Separate subdomains, not paths on one host: cookies scope per subdomain so a console session cannot
reach the marketing site, each deploys independently, and the extension declares one clean origin in
`host_permissions` — which matters at Web Store review, where a wildcard invites scrutiny.

**Secure the domain early.** Postmark needs SPF, DKIM and DMARC verified before magic links deliver
reliably, and DNS plus email reputation has lead time. Changing the API origin later means a
manifest change and a store review cycle.

**One console, not several.** Teams, Pilot and Institution differ by entitlement, not interface.

**Consoles and server stay private.** The extension is open source because the privacy claim needs
verification — it runs on the reader's machine. None of that applies server-side: nobody can verify
it by reading it, so publishing buys no trust while giving away entitlement logic, aggregation
logic, seat rules and SSO integration detail.

The split is easy to explain: *the part that runs on your computer is open; the part that runs on
ours is not, and it never sees what you read.*

---

## 6. Seats and invitations

1. An instructor buys N seats (25 minimum for Teams). Their own seat is free and uncounted.
2. They create a class and invite students by link, by email, or both.
3. A student accepts, creates an account, joins the class.
4. **Holding a seat grants Reader entitlements automatically**, while held.
5. Releasing frees the seat **immediately**; the account reverts to free. Local data stays theirs.
   Rejoin is immediate — no cooldown.

Grant Reader *by seat membership*, not as a separate tier.

**Invite modes, instructor's choice:**

| Mode | Behaviour |
|---|---|
| `domain` | Only addresses at a named domain. Natural for universities |
| `open` | Anyone with the link. Necessary for corporate training, which has no shared domain |

**`open` still needs a ceiling.** A link pasted publicly consumes 25 seats in an hour. Every invite,
both modes, carries `max_joins`, a **required** `expires_at`, and revocability. This is not a
restriction on *who* joins — it is a limit on *how many*, which is the actual exposure.

**What a student must be told at join, and this is the highest-stakes trust surface in the
product:** that the instructor sees aggregate results only, that nothing individual is visible, and
that the only exception is a receipt they choose to submit. The natural assumption on seeing "you
have been assigned a reading" is that someone is watching. Answer it before they ask.

---

## 7. Assigned readings

**Assignments are the container that makes aggregate reporting possible.** Without one there is no
cohort reading the same document, so nothing to aggregate. The assignment also issues the pseudonym
salt (§8).

**The instructor uploads the document.** PDF, PPTX or DOCX.

Decided against the alternative — storing only a document identity while students supply their own
copy. That avoids hosting content entirely, but makes the console heatmap impossible: you cannot
render a heatmap over a document you do not have. The heatmap is the feature.

**Hosting content has consequences to accept deliberately:**

- alcoia becomes a content host, as every LMS is. The instructor makes the copyright decision
  exactly as they do in Canvas. Required: terms placing responsibility on the uploader, a takedown
  process with a named contact, retention limits, genuine deletion at class end, documents scoped to
  one org and never cross-accessible.
- **The privacy claim narrows and the copy must change.** "We never see what you read" is no longer
  true unqualified. The accurate statement: *alcoia never sees your browsing; assigned material is
  uploaded deliberately by your instructor, and your reading of it is aggregated anonymously.*

**Format support is uneven and should be sequenced honestly:** PDF works. PPTX is coarse — one block
per slide — and its reconciliation is deferred. DOCX has no extraction pipeline. Do not advertise
three formats before three work.

**Notification.** A seat holder has an account, so there is no join code. On assignment they get an
in-app notification and an email.

- **The notification is not an interruption.** Popup and badge, never a card over what they are
  currently reading.
- **A due date is a window, not a countdown.** It closes aggregation. Displayed as a monitored
  deadline it turns a formative tool into a compliance one.
- **Reading before the assignment does not count.** Sessions attach from the moment a student joins.
  Retroactive attribution would need history level B does not hold.

---

## 8. The aggregate class view

The key feature of the institutional product. Instead of "any questions?", a lecturer gets *"most of
the class understood section 2, and almost everyone is struggling with section 4."*

### Assignment-scoped pseudonyms

Counting "78% of the class" requires counting **distinct** readers, which naively requires knowing
who submitted what — level C.

The resolution: **a student joining an assignment gets an identifier scoped to that assignment.**
Outcomes submit under it. The server counts distinct participants and computes percentages; it
cannot link a row to a person, or link one person across two assignments.

**Rejected alternative, recorded so it is not revisited:** rotating the pseudonym per session. It
makes identification permanently impossible, but three visits from one student count as three
people — and the bias is not random. Diligent students who return most get counted most, so the
class looks like it understood better than it did.

What this deliberately gives up: "is this student improving over the term." That is exactly the
linkage the design refuses. Treat it as part of the pitch — *we structurally cannot identify a
student* is stronger than any privacy policy.

### Minimum cohort floor

**5 distinct pseudonyms.** Below it, report *insufficient data*, never a percentage.

This is a privacy control, not a statistical nicety. Small numbers within a known class are
re-identifiable — an instructor who knows only four students reached section 5 can often work out
who they are. **Enforce in the API, not the console:** a console check is a display convention, an
API check is a guarantee.

### What the view shows

Ordered by how directly each changes what an instructor does next.

1. **Trouble map** — struggle, re-reading and failed questions per paragraph
2. **Confidently wrong** — where the class was *sure* and wrong
3. **Question failure rates**, each with the passage it cites
4. **Abandonment point** — where readers stopped. If 40% never reached section 4, its aggregate
   means something different
5. **Completion beside comprehension** — the contrast between "94% opened it" and "38% could answer
   about section 3" is the commercial pitch in one line

**Signals 1 and 2 must be visually and structurally distinct, never merged into one score.** They
call for opposite teaching responses. A hard passage wants more explanation — often one an
experienced lecturer could have predicted. A confidently-wrong passage is a **misconception**, where
more explanation slides off because students believe they already understand; the response has to
surface the contradiction first. One combined "trouble" number tells the lecturer to do the wrong
thing half the time.

**Do not build:** per-student anything, rankings, leaderboards, or a class average presented as a
grade. Each converts a formative tool into an assessment tool — the weaker product, and the one
institutions are retreating from.

### Reporting modes

`anonymous` (default) or `identified`.

| | Anonymous | Identified |
|---|---|---|
| Instructor sees | Aggregate only | Per-student |
| Cohort floor | Applies | Not applicable |
| Student told at join | Aggregate only, nothing individual | Instructor sees individual results |
| Salt retention | 12 months after close | Class lifetime |
| Available on | All paid tiers | Teams and Institution only, never Pilot |

**Three non-negotiable conditions:** mode is chosen at class creation; a class **cannot** change
mode once students have joined (create a new class); students are told at the moment they join.

Data collected under a promise of anonymity cannot later be de-anonymised. If a student is told
"aggregate only" and that changes afterwards, the statement was false when made — and it was made to
the student, not the institution, so an institutional agreement does not repair it.

---

## 9. Receipts

A **receipt** is a record of a reading session the reader generates themselves. Never submitted in
the background.

**The asymmetry is the point:**

| | Aggregate view | Receipt |
|---|---|---|
| Identified | No | Yes |
| Automatic | Yes | No |
| Who decides | Nobody | The student |

The student decides which the instructor sees. Submission is therefore the one place per-student
visibility is legitimate.

**What a signature proves, exactly.** That the receipt is byte-for-byte what the server issued. It
proves **nothing** about whether the reading happened — the figures come from the reader's own
browser. Wording is **"unaltered since issued"**, never "verified", never "authentic".

**Never accuse.** A receipt reports unaltered or nothing. Atypical behaviour has innocent causes:
motor impairment, assistive technology, a trackpad, a phone.

---

## 10. LMS integration — Institution tier

**LTI 1.3, Canvas first** (roughly a third of the North American higher-education market). alcoia is
the *tool*; the LMS is the *platform*.

What it buys: launch (a student clicks in Canvas and lands authenticated, in the right class, on the
right document), roster sync via NRPS (seats populate from enrolment; drops lose access), and deep
linking (an instructor attaches an alcoia reading from inside Canvas).

**Grade passback is refused.** Two reasons, both recorded in code:

- If a grade depends on alcoia's numbers, students optimise for alcoia's numbers. Questions fire on
  detected struggle, so a student who wants the mark reads slowly and scrolls back to *appear* to
  struggle. Genuine human scrolling, merely performed — nearly undetectable, and it poisons the
  corpus the detector depends on. The same argument that ruled out XP and streaks, arriving through
  the gradebook.
- A receipt proves only "unaltered since issued". Pushing it to a gradebook as a mark implies a
  verification alcoia has explicitly said it cannot provide.

*"We integrate with your gradebook; we don't grade your students"* is a defensible sales sentence.
If completion passback is ever added it must be completion only, labelled self-reported.

---

## 11. Institution tier

**Self-hosted backend.** A sales unlock, not a roadmap item — floor price, and do not build until a
signed contract requires it. Three realities: they still need their own model endpoint; you must
license them server code; support cost is unbounded.

**Procurement support and onboarding.** Human work, not engineering.

---

## 12. Pilot

Identical to Teams, free, under 25 students. **Without SSO and DPA** — both are per-customer cost
rather than per-seat. SSO is integration work per identity provider plus support when it breaks; a
DPA is a signed agreement, and offering it free means signing contracts with non-paying users.

*Pilot gives you everything a class needs. SSO, DPA and procurement come with a paid agreement.*

**Triggering.** "Run a pilot" creates the class immediately — collect an email, create the class,
send the invite link, follow up as a human. A contact form reintroduces the sales cycle the free
pilot exists to remove.

**OPEN — Pilot abuse.** Two classes of 24 cost nothing where one class of 48 does not. Options:
accept it, time-limit Pilot to one term, or one concurrent pilot per institution.

---

## 13. Do not build

| | Why |
|---|---|
| XP, levels, streaks, leaderboards, confetti | Optimise against independence, and reward-for-struggle poisons the detector's corpus |
| Device or network fingerprinting | Invariant |
| Free-form "epistemic adversary" mode | Needs a personality instruction to the model. An education product used by minors must not let the model improvise. A constrained version drawing challenges from the passage's own counterarguments may be revisited |
| Images fetched into intervention cards | Rights problem, breaks the zero-third-party-request guarantee, and illustration produces the fluency illusion the product counters |
| Accuracy percentages, anywhere | At least eight exist across project materials; all from synthetic data, the shipped one with train/test leakage. No real-participant evaluation has ever been performed |
| Per-student institutional reporting outside identified mode | Converts formative to assessment |
| Grade passback | §10 |
| Spaced review, vocabulary lists with review | Level C |

### On a sellable API or SDK

**An API is the wrong shape.** Of the capabilities worth selling, difficulty detection and question
generation are API-shaped and largely commodity; reading friction and retrieval timing require live
browser instrumentation and cannot exist over HTTP; mastery and knowledge gaps are level C. So the
API-shaped parts are the replaceable ones, and selling them lets someone build a rival study tool on
your infrastructure and inference cost.

**An SDK is a genuinely different proposition** — an embeddable library doing client-side
instrumentation inside a customer's own reader, calling back to alcoia's server. That carries the
friction detection, which is the actual moat.

**Two things gate it, one with a deadline.** The extension is AGPL-3.0, so an SDK embedded in a
customer's proprietary application triggers copyleft — you would need dual licensing, which means
**no external contribution can ever be merged without a CLA**, or you lose the right to relicense
your own code. That decision must precede the first outside PR. And with zero users, breadth is the
enemy; developer sales is a different motion from institutional sales.

Right shape, wrong year. Settle the licensing question now because it is cheap and irreversible
later.

---

## 14. Open questions

| # | Question | Blocks |
|---|---|---|
| 1 | Difficulty ladder above Explain — needs a level-dependent validator | Question generation |
| 2 | Free-text model-scored answers — grader authority and disclosure | Ladder rungs 2–4 |
| 3 | Pilot abuse cap | Entitlement rules |
| 4 | Data residency for institutional buyers | Hosting region, sub-processor list |
| 5 | Magic link → extension session handoff | Every paid extension feature |
| 6 | DOCX and PPTX extraction pipelines | Assignment format claims |
| 7 | CLA / dual licensing | Any future SDK |