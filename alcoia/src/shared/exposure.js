/* exposure.js: tells the server which ideas of an ASSIGNED reading the reader has met, so "has this been encountered"
 * is known from ordinary reading and not only from questions.
 *
 *   POST {exposureUrl}  { unitIds: [knowledgeUnitId, ...] }   (account session, learner memory on)
 *
 * Only content-hash ids of paragraphs the reader actually spent time on go out, in small batches, with no times and no
 * order. The server turns them into one encounter per idea and keeps no per-paragraph or per-time record. Each unit is
 * reported at most once per page load. Never throws. */
export function createExposureReporter(opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const getSession = opts.getSession;
  const exposureUrl = opts.exposureUrl;
  const batchSize = opts.batchSize ?? 12;
  const seen = new Set();
  let queue = [];
  let inflight = null;

  function note(unitId) {
    if (typeof unitId !== 'string' || !unitId || seen.has(unitId)) return;
    seen.add(unitId);
    queue.push(unitId);
    if (queue.length >= batchSize) flush();
  }
  function flush() {
    if (inflight || !queue.length) return inflight || Promise.resolve(false);
    const batch = queue.splice(0, 40);
    inflight = (async () => {
      try {
        const session = await getSession?.();
        if (!session || typeof session.token !== 'string' || !session.token || !exposureUrl || !fetchImpl) return false;
        const resp = await fetchImpl(exposureUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ unitIds: batch }),
        });
        return Boolean(resp.ok);
      } catch (e) { return false; } finally { inflight = null; }
    })();
    return inflight;
  }
  return { note, flush, pendingCount: () => queue.length };
}
