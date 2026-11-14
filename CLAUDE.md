
## 14 November 2026: "I know this", then-and-now line, detector counters
- The question card has an "I know this" button (only when the host passes `onKnown`): it leaves without a dismissal and without credit, and logs `flag_known` locally. 3 or 4 options are accepted (the stored bank has three).
- The outcome reply's `thenAndNow` shows one muted line under the card (`then.line`, all 12 languages, no motion).
- Answered detector-triggered cards and probes add `flag_wrong / flag_right_sure / probe_wrong / probe_right_sure` to the pool (by state and basis) and the local log. Not accuracy.
- Response table, overload row: an overloaded reader (substate `overload`) gets a shorter, plainer explanation (summarize mode `simplify`) instead of a question, only when their own evidence has not already chosen a response. Not built: the fork row (the `unclear` two-button strip) and help requests.
- Alt+M marks the paragraph you are on as hard: no card, a short status line, and the paragraph is weighted up for the end-of-session check (same path struggles use). Counted locally as `marked`. No touch control yet.
