
## 14 November 2026: "I know this", then-and-now line, detector counters
- The question card has an "I know this" button (only when the host passes `onKnown`): it leaves without a dismissal and without credit, and logs `flag_known` locally. 3 or 4 options are accepted (the stored bank has three).
- The outcome reply's `thenAndNow` shows one muted line under the card (`then.line`, all 12 languages, no motion).
- Answered detector-triggered cards and probes add `flag_wrong / flag_right_sure / probe_wrong / probe_right_sure` to the pool (by state and basis) and the local log. Not accuracy.
- Not built: the response table's fork, Alt+M mark, help requests.
