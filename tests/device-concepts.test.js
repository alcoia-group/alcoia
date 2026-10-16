import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { createDeviceConcepts, extractTerms, estimateFromCounts, paragraphEstimate } from '../alcoia/src/shared/device-concepts.js';

function memoryStorage() {
  const data = {};
  return {
    data,
    get: (keys, cb) => cb(Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, data[k] ?? d]))),
    set: (obj, cb) => { Object.assign(data, JSON.parse(JSON.stringify(obj))); cb?.(); },
    remove: (k, cb) => { delete data[k]; cb?.(); },
  };
}
const P = (n) => `Paragraph ${n}: the attention mechanism computes weights over tokens, and the attention mechanism scales with sequence length.`;

describe('device concepts', () => {
  it('has no network code and imports nothing', () => {
    const src = fs.readFileSync(new URL('../alcoia/src/shared/device-concepts.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toMatch(/fetch\s*\(|XMLHttpRequest|sendMessage|sendBeacon|WebSocket|^import\s/m);
  });

  it('finds named terms, acronyms and content-word runs, and skips stop words', () => {
    const keys = extractTerms('We introduce a method called self attention. The GAN loss is stable.').map((t) => t.key);
    expect(keys).toContain('self attention');
    expect(keys).toContain('gan');
    expect(keys.some((k) => k.startsWith('the '))).toBe(false);
  });

  it('only treats a term as an idea once it has appeared in enough paragraphs of the page', async () => {
    const dc = createDeviceConcepts({ storage: memoryStorage() });
    expect(await dc.noteRead('p1', P(1))).toEqual([]);
    expect(await dc.noteRead('p2', P(2))).toEqual([]);
    expect(await dc.noteRead('p3', P(3))).toContain('attention mechanism');
  });

  it('turns repeated misses into needs_help (an explanation) and clean answers into abstain; one miss says nothing', async () => {
    const storage = memoryStorage();
    const dc = createDeviceConcepts({ storage });
    for (const i of [1, 2, 3, 4, 5, 6]) await dc.noteRead(`p${i}`, P(i));
    await dc.noteAnswer('p4', false);
    expect(dc.estimateFor('p4')).toBeNull();
    await dc.noteAnswer('p5', false);
    expect(dc.estimateFor('p6')).toMatchObject({ action: 'intervene', kind: 'explain', level: 'needs_help' });
    // a null (ungraded) answer counts for nothing
    const counts = async () => (await dc.list()).map((r) => [r.key, r.enc, r.ok, r.bad]);
    const before = await counts();
    await dc.noteAnswer('p6', null);
    expect(await counts()).toEqual(before);

    const good = createDeviceConcepts({ storage: memoryStorage() });
    for (const i of [1, 2, 3, 4, 5, 6]) await good.noteRead(`p${i}`, P(i));
    for (const i of [4, 5, 6]) await good.noteAnswer(`p${i}`, true);
    expect(good.estimateFor('p6')).toMatchObject({ action: 'abstain' });
  });

  it('stores only short labels and counts, never page text, caps its size and clears', async () => {
    const storage = memoryStorage();
    const dc = createDeviceConcepts({ storage, maxConcepts: 3 });
    for (const i of [1, 2, 3, 4]) await dc.noteRead(`p${i}`, P(i) + ' https://secret.example/page');
    await dc.noteAnswer('p4', false);
    await dc.list();
    const raw = JSON.stringify(storage.data);
    expect(raw).not.toMatch(/secret\.example|Paragraph \d:|computes weights/);
    expect(Object.keys(storage.data.sra_device_concepts).length).toBeLessThanOrEqual(3);
    await dc.clear();
    expect(storage.data.sra_device_concepts).toBeUndefined();
    expect(await dc.list()).toEqual([]);
  });

  it('pure helpers', () => {
    expect(estimateFromCounts({ ok: 3, bad: 0 })).toBe('secure');
    expect(estimateFromCounts({ ok: 1, bad: 2 })).toBe('needs_help');
    expect(estimateFromCounts({ ok: 2, bad: 2 })).toBe('unknown');
    expect(paragraphEstimate([])).toBeNull();
  });
});
