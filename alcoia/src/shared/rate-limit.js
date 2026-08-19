/* rate-limit.js — tiny in-memory burst+ceiling limiter (item 43)
 *
 * Extracted out of host.js's own checkAiCallBudget() so a second context
 * with its own module instance — quiz.js, a normal extension page, not
 * sharing host.js's closure — can give its own AI calls the same "bug
 * backstop, not security control" shape (the project notes, item 38) without
 * re-deriving the burst/ceiling math by hand. Each caller that constructs
 * one gets its own independent counters, same as host.js's own
 * aiCallTimestampsByPath always has — this adds no shared state across
 * contexts and enforces nothing a determined caller couldn't bypass by
 * reloading the page; it exists to catch bugs, not attackers.
 *
 * host.js's own checkAiCallBudget() is left as its own inline copy rather
 * than rewritten to call this — it is already covered by host.test.js and
 * carries no reuse need of its own; this module exists for the one new
 * caller (quiz.js) that does.
 */
export function createRateLimiter({ burstLimit, burstWindowMs, ceilingLimit, ceilingWindowMs, onLimited } = {}) {
  const timestampsByPath = {};

  function check(path) {
    const now = Date.now();
    const list = (timestampsByPath[path] || (timestampsByPath[path] = []))
      .filter((t) => now - t < ceilingWindowMs);
    timestampsByPath[path] = list;

    const burstCount = list.filter((t) => now - t < burstWindowMs).length;
    if (burstCount >= burstLimit) { onLimited?.(path, 'burst', burstCount); return false; }
    if (list.length >= ceilingLimit) { onLimited?.(path, 'ceiling', list.length); return false; }

    list.push(now);
    return true;
  }

  return { check };
}
