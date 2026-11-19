/* argument-cues.js -- does this paragraph argue for a position?
 *
 * A paragraph that takes a side (says something should be done, states what the author believes, or presents a
 * conclusion as following from evidence) is one a reader should be able to push back on, not only repeat. When this
 * is true, a reader who has answered correctly about the paragraph may be offered one challenge question ("a critic
 * says the claim is wrong; which reply holds up") instead of another question of the same kind. It is a small,
 * transparent heuristic over stance words in English; it only changes WHICH question is asked, never whether to
 * interrupt, so a miss costs nothing. Other languages fall back to the ordinary ladder.
 */
const STANCE = [
  /\b(should|ought to|must not|must be|need to|needs to|has to be)\b/i,
  /\b(we argue|i argue|the author argues|argues that|we believe|i believe|in my view|in our view|i think|we think|we contend|we propose)\b/i,
  /\b(it is clear that|clearly|undoubtedly|without doubt|there is no doubt|obviously|it follows that|this proves|this shows that|this demonstrates)\b/i,
  /\b(the best|the only way|the right way|the wrong way|is better than|is worse than|is superior|is inferior)\b/i,
  /\b(critics|opponents|proponents|supporters|some argue|others argue|it has been argued|the evidence suggests|evidence shows)\b/i,
];

export function hasArgumentCues(text) {
  if (typeof text !== 'string' || text.length < 60) return false;
  let hits = 0;
  for (const re of STANCE) if (re.test(text)) hits += 1;
  return hits >= 1 && /[.;:!?]/.test(text);
}
