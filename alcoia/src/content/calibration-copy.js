/* calibration-copy.js — the four-outcome confidence-calibration table
 *
 * From CLAUDE.md's confidence-calibration table, reworded as reader-facing
 * copy. Wrong+high gets no harsher tone than wrong+low — confidently wrong
 * is the case learning matters most for, not a case for a scolding tone.
 *
 * Shared between question-card.js (the single retrieval question) and the
 * quiz page (item 17, several questions in a row) so the wording cannot
 * drift between the two surfaces.
 */
export const CALIBRATION_COPY = Object.freeze({
  correct: {
    high: 'Correct, and appropriately confident.',
    low:  'Correct. You knew more than you thought.',
  },
  incorrect: {
    high: "Not quite, and you were sure. That's worth noticing.",
    low:  "Not quite, and you weren't sure. That's good calibration.",
  },
});

/* correct: boolean, confidence: 'low' | 'high' | null. Returns null when no
 * confidence was given — callers fall back to their own bare copy, since a
 * skipped rating must not be treated as either 'low' or 'high'. */
export function calibratedLine(correct, confidence) {
  if (confidence !== 'low' && confidence !== 'high') return null;
  return CALIBRATION_COPY[correct ? 'correct' : 'incorrect'][confidence];
}
