/* predictions.js — "before you read on" prompts for one assigned reading.
 *
 *   GET {ASSIGNMENTS_URL}/:assignmentId/predictions -> 200 { predictions: [{ unitId, afterUnitIds, prompt }] }
 *
 * Built once per document by the server from its document graph (a claim the reading derives later, and the claims it
 * rests on). Document content only: nothing about the reader goes up, nothing is recorded, and the reader's prediction
 * is never sent anywhere or graded. Never throws; a failure means no prompts. */
export function createPredictionsManager(opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const { getSession, predictionsUrl } = opts;
  async function getPredictions() {
    try {
      const session = await getSession();
      if (!session?.token || !predictionsUrl || !fetchImpl) return [];
      const resp = await fetchImpl(predictionsUrl, { method: 'GET', headers: { Authorization: `Bearer ${session.token}` } });
      if (!resp.ok) return [];
      const data = await resp.json().catch(() => null);
      return (Array.isArray(data?.predictions) ? data.predictions : [])
        .filter((p) => p && typeof p.unitId === 'string' && Array.isArray(p.afterUnitIds) && typeof p.prompt === 'string' && p.prompt.trim())
        .map((p) => ({ unitId: p.unitId, afterUnitIds: p.afterUnitIds.filter((u) => typeof u === 'string'), prompt: p.prompt.trim().slice(0, 300) }));
    } catch (e) {
      return [];
    }
  }
  return { getPredictions };
}

/* Pure: the prediction to offer now, or null. A prompt is offered once, after the reader has read every paragraph
 * its conclusion rests on (the paragraph just read being one of them), and only while the conclusion is still unread. */
export function predictionToOffer(predictions, { justRead, readUnits, shown }) {
  for (const p of predictions) {
    if (shown.has(p.unitId) || readUnits.has(p.unitId)) continue;
    if (!p.afterUnitIds.includes(justRead)) continue;
    if (p.afterUnitIds.every((u) => readUnits.has(u))) return p;
  }
  return null;
}
