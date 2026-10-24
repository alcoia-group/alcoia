/* transfer-check.js: remembers, for this page session only, which paragraphs were explained and in which style, so a
 * follow-up question can check whether the explanation carried over to using the idea.
 *
 * Why. An answer given right after an explanation is recorded by the server as "assisted": it says the reader could
 * answer with the help in front of them, not that the idea carries over. The server (alcoiaServer, "Transfer check")
 * says which paragraphs still need a transfer check and at which tier; this module adds what only the page can see:
 * how many other paragraphs were read since, and which way of explaining was used.
 *
 * In memory only. Nothing here is written to storage or sent anywhere except the closed-list style key that is
 * reported through the existing policy-events batch, and the passage text is held only so the follow-up question can
 * be asked about the paragraph that was explained (it is sent to the question endpoint exactly as any question is).
 *
 * Inferred style feedback. If the reader tapped "did this help?" on the explanation, that tap is the feedback and
 * nothing is inferred. Otherwise the later transfer check stands in for it: success is an inferred "helped", anything
 * else an inferred "not helped" (the server weights an inferred result at half a tap; see INFERRED_WEIGHT there). A
 * failed check with no tap also marks the style as one to avoid for that paragraph for the rest of the session. A tap
 * that arrives after a result has been inferred cannot take it back (the counts are already queued), which is a
 * stated limit. */
export const SPACING_OTHER_PARAGRAPHS = 2; // same-session tier: at least this many other paragraphs read since the explanation
export const SPACING_MS = 3 * 60 * 1000; // ... and at least about three minutes (the server enforces the same floor)
export const MAX_ATTEMPTS = 2; // unconfirmed attempts per explanation; then it is recorded as "did not carry over" and no more are asked
const MAX_UNITS = 40;

export function createTransferTracker({ now = () => Date.now() } = {}) {
  const units = new Map(); // knowledgeUnitId -> record
  const avoided = new Map(); // knowledgeUnitId -> style key ('mode:style') not to use again for it this session

  function noteExplained(unitId, { text = '', mode = null, style = null, paragraphIndex = null } = {}) {
    if (!unitId) return;
    units.delete(unitId);
    units.set(unitId, { text: String(text || ''), paragraphIndex: Number.isInteger(paragraphIndex) ? paragraphIndex : null, key: mode && style ? `${mode}:${style}` : null, at: now(), others: 0, tapped: false, settled: false, attempts: 0, asked: new Set() });
    if (units.size > MAX_UNITS) units.delete(units.keys().next().value);
  }
  function noteTap(unitId) {
    const r = units.get(unitId);
    if (r) r.tapped = true;
  }
  function noteParagraphRead(unitId) {
    for (const [id, r] of units) if (id !== unitId && !r.settled) r.others += 1;
  }
  const spacingMet = (r) => !r.settled && r.others >= SPACING_OTHER_PARAGRAPHS && now() - r.at >= SPACING_MS;
  function readyUnits() {
    const out = [];
    for (const [unitId, r] of units) if (spacingMet(r) && r.text) out.push({ unitId, text: r.text, paragraphIndex: r.paragraphIndex });
    return out;
  }
  /* A transfer question was asked about this unit. Each try must be a different question, so the text is remembered
   * (this session only), and the spacing starts again for the next one. */
  function noteAsked(unitId, questionText) {
    const r = units.get(unitId);
    if (r && questionText) r.asked.add(String(questionText).trim());
  }
  const askedBefore = (unitId, questionText) => Boolean(units.get(unitId)?.asked.has(String(questionText || '').trim()));
  /* An answer that could not be confirmed counts as an attempt (the server keeps its own count; at most MAX_ATTEMPTS). */
  function noteAttempt(unitId) {
    const r = units.get(unitId);
    if (!r) return 0;
    r.attempts += 1;
    r.at = now();
    r.others = 0;
    return r.attempts;
  }
  /* No usable verdict (the grader was unavailable): nothing happened, but do not ask again straight away. */
  function noteDeferred(unitId) {
    const r = units.get(unitId);
    if (r) { r.at = now(); r.others = 0; }
  }
  const attemptsOf = (unitId) => units.get(unitId)?.attempts ?? 0;
  const textOf = (unitId) => units.get(unitId)?.text ?? '';
  const isExplained = (unitId) => units.has(unitId) && !units.get(unitId).settled;

  /* The transfer check for this unit has been answered. success: the answer was confirmed correct. Returns the
   * inferred style event to report (or null when the reader tapped, or no style was used). */
  function settle(unitId, success) {
    const r = units.get(unitId);
    if (!r || r.settled) return null;
    r.settled = true;
    if (r.tapped || !r.key) return null;
    if (!success) avoided.set(unitId, r.key);
    return { scope: 'style', key: r.key, ...(success ? { helpedInferred: 1 } : { notHelpedInferred: 1 }) };
  }
  /* The style (just the name, e.g. 'analogy') not to repeat for this paragraph's next explanation, or null. */
  function avoidStyleFor(unitId) {
    const key = avoided.get(unitId);
    return key ? key.split(':')[1] ?? null : null;
  }

  return { noteExplained, noteTap, noteParagraphRead, readyUnits, textOf, isExplained, settle, avoidStyleFor, noteAsked, askedBefore, noteAttempt, noteDeferred, attemptsOf };
}
