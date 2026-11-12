import { describe, it, expect, vi } from 'vitest';
import { predictionToOffer, createPredictionsManager } from '../alcoia/src/shared/predictions.js';

const P = [{ unitId: 'k3', afterUnitIds: ['k1', 'k2'], prompt: 'What do you expect to float?' }];

describe('prediction prompts', () => {
  it('offered once every premise is read and the conclusion is not', () => {
    const shown = new Set();
    expect(predictionToOffer(P, { justRead: 'k1', readUnits: new Set(['k1']), shown })).toBeNull();
    expect(predictionToOffer(P, { justRead: 'k2', readUnits: new Set(['k1', 'k2']), shown })).toBe(P[0]);
    expect(predictionToOffer(P, { justRead: 'k2', readUnits: new Set(['k1', 'k2', 'k3']), shown })).toBeNull();
    expect(predictionToOffer(P, { justRead: 'k2', readUnits: new Set(['k1', 'k2']), shown: new Set(['k3']) })).toBeNull();
  });
  it('a failed or malformed fetch gives no prompts and never throws', async () => {
    const getSession = async () => ({ token: 't' });
    expect(await createPredictionsManager({ getSession, predictionsUrl: 'u', fetchImpl: vi.fn(async () => { throw new Error('x'); }) }).getPredictions()).toEqual([]);
    const ok = vi.fn(async () => ({ ok: true, json: async () => ({ predictions: [...P, { unitId: 1 }] }) }));
    expect(await createPredictionsManager({ getSession, predictionsUrl: 'u', fetchImpl: ok }).getPredictions()).toEqual(P);
    expect(ok.mock.calls[0][1].headers.Authorization).toBe('Bearer t');
  });
});
