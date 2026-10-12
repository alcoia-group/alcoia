/* relation-cues.js -- does this paragraph say how ideas connect?
 *
 * A struggling reader often reads every sentence but misses how the ideas fit together. When a paragraph is
 * built on a relationship (cause, dependence, contrast, comparison, part-of), an explanation that points at the
 * relationship ("Look at how X and Y are connected") helps more than a rewrite. This is a small, transparent
 * heuristic over connective words in English; it only chooses WHICH explanation to fetch, never whether to
 * interrupt, so a miss costs nothing (the ordinary explanation is used). Other languages fall back to the
 * ordinary explanation.
 */
const CUES = [
  /\b(because|therefore|thus|hence|consequently|as a result|due to|leads? to|results? in|causes?|caused by|so that)\b/i,
  /\b(depends? on|depending on|relies on|requires?|in order to|only if|unless|provided that)\b/i,
  /\b(whereas|while|in contrast|by contrast|on the other hand|unlike|however|but)\b/i,
  /\b(compared (with|to)|more than|less than|as \w+ as|similar to|differs? from|the same as)\b/i,
  /\b(part of|consists? of|made up of|composed of|belongs? to|kind of|type of|example of)\b/i,
  /\b(increases?|decreases?|rises?|falls?|grows?|shrinks?)\b[^.]{0,60}\b(as|when|while)\b/i,
];

export function hasRelationCues(text) {
  if (typeof text !== 'string' || text.length < 40) return false;
  let hits = 0;
  for (const re of CUES) if (re.test(text)) hits += 1;
  return hits >= 1 && /[.;:]/.test(text);
}
