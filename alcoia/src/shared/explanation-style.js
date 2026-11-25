/* explanation-style.js: which way of explaining to try for THIS learner.
 *
 * The server keeps, per summarize mode, an ordered list of the styles the learner's own results favour
 * ({ style, n, trials, rate }, best first; see alcoiaServer learnerModel/policyProfile.js). This picks one:
 * mostly the best, sometimes the least-tried so the order can change as the learner changes. Nothing is fixed and
 * nothing here labels the learner; with no list (signed out, memory off, older server) it returns null and the
 * ordinary prompt is used. Pure and testable: the random source is injected. */
/* The closed list of layouts the server accepts (alcoiaServer ai/explanation-styles.js). Used only to try another
 * layout on a paragraph that has already had one when the learner has no profile of their own. */
export const STYLE_NAMES = Object.freeze(['example_first', 'analogy', 'step_by_step', 'scenario', 'plain_definition', 'contrast']);

/* opts.avoid: one style name or a list of them (a layout that did not carry over, or that this paragraph has already
 * had). The marker '_default' means "the ordinary prompt with no layout was used". */
export function chooseStyle(list, rng = Math.random, opts = {}) {
  const avoid = new Set([].concat(opts.avoid || []).filter(Boolean));
  // opts.prefer: layouts that suit the KIND of difficulty (for example a worked example for someone who said "I don't
  // know"). A clear difficulty beats the learned order; one already used on this paragraph is skipped.
  const preferred = [].concat(opts.prefer || []).find((x) => STYLE_NAMES.includes(x) && !avoid.has(x));
  if (preferred) return preferred;
  if (!Array.isArray(list) || list.length === 0) {
    // No profile. Normally the ordinary prompt; but a paragraph that already had help gets a different layout.
    if (avoid.size === 0) return null;
    const rest = STYLE_NAMES.filter((x) => !avoid.has(x));
    const pool = rest.length ? rest : STYLE_NAMES;
    return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
  }
  let valid = list.filter((x) => x && typeof x.style === 'string' && x.style);
  // A style that just failed the follow-up check for this paragraph, or that this paragraph has already had, is not
  // repeated while there is another to try; the rest are chosen as usual, including the occasional least-tried one.
  if (avoid.size) {
    const rest = valid.filter((x) => !avoid.has(x.style));
    if (rest.length) valid = rest;
    else {
      // Every style this learner has results for has been used here: try one they have no results for yet.
      const fresh = STYLE_NAMES.filter((x) => !avoid.has(x));
      if (fresh.length) return fresh[Math.min(fresh.length - 1, Math.floor(rng() * fresh.length))];
    }
  }
  if (valid.length === 0) return null;
  const total = valid.reduce((a, x) => a + (Number.isFinite(x.n) ? x.n : 0), 0);
  // Early on there is little to go on, so try more; with a lot of evidence, mostly keep to what works.
  const exploreP = total < 12 ? 0.4 : 0.15;
  if (rng() < exploreP && valid.length > 1) {
    const min = Math.min(...valid.map((x) => (Number.isFinite(x.n) ? x.n : 0)));
    const least = valid.filter((x) => (Number.isFinite(x.n) ? x.n : 0) === min);
    return least[Math.min(least.length - 1, Math.floor(rng() * least.length))].style;
  }
  return valid[0].style;
}
