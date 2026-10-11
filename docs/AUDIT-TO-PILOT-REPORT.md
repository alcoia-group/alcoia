# From the readiness audit to the pilot: what changed and why

Scope: everything done in this repository from the read-only intelligence-readiness audit (which found that several things the product said or measured were not true or not measured) through Stage A (correct what is false), Stage B (use the learner's evidence to decide what to do), privacy hardening of the instructor views, and Stage C (verification). Dates are 2026-10-09 to 2026-10-11, branch `community-mvp-6dq9qd`.

The audit itself produced no code. Its findings drove the commits below: wrong claims about question levels and participation, answers after an explanation being counted as independent success, exact small counts that could identify students, receipts visible or stored where the class promised anonymity, and no protection against a retry double-counting.

## Commits in this repository (alcoia, the browser extension), oldest first

| Commit | Goal |
|---|---|
| `65e4507` | Send, with each intervention report, whether it was a question, an explanation or a repair. |
| `e62df9d` | Merge main into the working branch. |
| `436fc7a` | Stage A. Only request question levels the server can deliver; fix stale comments about the outcome fields. |
| `b3abc53` | Stage A. Exactly one outcome and one intervention per answered question, in both inline and quiz paths. |
| `cff1fcb` | Remove exploration sampling: readers who are reading fine are no longer interrupted by a random draw. |
| `1111d5d` | Provenance. Track every explanation the reader was shown; send "no help beforehand" (explicit false) only when none was observed, and say nothing when it cannot be attributed. |
| `1b2193e` | Join notice states what a reading receipt can contain, what it does and does not prove, and that nothing is sent on its own. |
| `0f8ca86` | Join notice: anonymous classes do not accept receipt submissions. |
| `f6094f0` | Provenance fix. One unmatched explanation no longer marks every later answer "unknown"; only the paragraph it most plausibly belongs to is affected. |
| `f93d16a` | Stage B. The extension fetches the learner's estimates and lets them narrow what the reading signals already justified: stay quiet, explain, or repair. All budgets, cooldowns, back-offs and open-card checks still apply. |

Verified at `f93d16a`: 67 test files, 1566 tests passing; lint 0 errors (3 older warnings).
## What these changes mean for the philosophy of the software

Alcoia's stated purpose is that a reader should need it *less* over time, and that it is a formative tool, never a surveillance or grading tool. This body of work moved the software closer to that purpose in six ways.

1. **Say only what the evidence supports.** Before, the software could present a guess as a fact (a "level" it could not actually deliver, a "participant" count that really meant "people who left a trace", a "correct" answer that came straight after being shown the explanation). Now each of those is either measured honestly or labelled as unknown. Missing evidence is never read as mastery, and never as failure.
2. **An answer after help is not proof of understanding.** A correct answer given right after an explanation, a repeated question, or an answer whose history is unknown is recorded as an attempt, not as independent success. Only an unaided answer, ideally confirmed after a delay, counts as evidence the reader can do it alone. This is the "need it less" principle made concrete.
3. **Interrupt less, and only for a reason.** The software now uses what it already knows about the reader (per reading, per paragraph) to stay quiet when a question would add no information, to explain instead of asking a third time, and to repair after a real miss. The random "extra question" on readers who were reading fine was removed.
4. **Privacy by structure, not by promise.** In anonymous classes the instructor can no longer subtract small numbers, watch a count tick up, or read a receipt, a content graph, or generated advice that only makes sense for a handful of people. Exact small figures are replaced by plain bands ("a few", "some", "most") or are withheld, and the server, not the screen, enforces it. This does not make re-identification impossible; the documents say so.
5. **Private learning memory stays private.** What a reader has learned is theirs; instructors see only cohort-level, banded signals, and a reader who turns memory off is not counted.
6. **Reliability over cleverness.** Saving an answer and updating the reader's memory now succeed or fail together, a retry can never double-count, and failures degrade quietly instead of breaking the page.

### Honest limits (nothing here proves the product improves learning)
- All numeric thresholds (one-day confirmation, 14-day staleness, the review ladder, the floor of five, the band cut-points) are provisional placeholders.
- Nothing was evaluated with real learners or against a real AI provider (no key or network access was available). Passing tests show the rules behave as designed, not that the questions and explanations are good.
- Learner memory and instructor retention statistics are ON by default. The legal basis, treatment of minors, and the public legal wording are not settled and need owner and counsel decisions.
- A meaningful "apply" intervention (using knowledge in a new situation) does not exist; the loop is Orient, Understand, Retrieve, Repair, Retrieve again later.
- Several jobs (document cleanup, salt deletion, billing notices) exist as commands but nothing in the repositories schedules them. The host must.
