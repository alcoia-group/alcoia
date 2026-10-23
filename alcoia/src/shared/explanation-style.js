/* explanation-style.js: which way of explaining to try for THIS learner.
 *
 * The server keeps, per summarize mode, an ordered list of the styles the learner's own results favour
 * ({ style, n, trials, rate }, best first; see alcoiaServer learnerModel/policyProfile.js). This picks one:
 * mostly the best, sometimes the least-tried so the order can change as the learner changes. Nothing is fixed and
 * nothing here labels the learner; with no list (signed out, memory off, older server) it returns null and the
 * ordinary prompt is used. Pure and testable: the random source is injected. */
export function chooseStyle(list, rng = Math.random, opts = {}) {
  if (!Array.isArray(list) || list.length === 0) return null;
  let valid = list.filter((x) => x && typeof x.style === 'string' && x.style);
  // A style that just failed the follow-up check for this paragraph (and the reader gave no tap of their own) is not
  // repeated while there is another to try; the rest are chosen as usual, including the occasional least-tried one.
  if (opts.avoid && valid.length > 1) valid = valid.filter((x) => x.style !== opts.avoid);
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
