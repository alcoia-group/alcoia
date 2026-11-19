import { describe, it, expect } from 'vitest';
import { createPinnedStore, pageKeyFor, MAX_PER_PAGE, MAX_PAGES } from '../alcoia/src/content/pinned-cards.js';

function fakeArea() {
  const data = {};
  return {
    data,
    get: (defaults, cb) => cb({ ...defaults, ...data }),
    set: (obj, cb) => { Object.assign(data, JSON.parse(JSON.stringify(obj))); cb?.(); },
  };
}

describe('pinned cards store', () => {
  it('keys a page by origin and path, not by fragment or query', () => {
    expect(pageKeyFor({ origin: 'https://a.test', pathname: '/a/1' })).toBe('https://a.test/a/1');
  });

  it('saves, loads and removes a card for its page only', async () => {
    const area = fakeArea();
    const a = createPinnedStore({ storage: area, pageKey: 'p1' });
    const b = createPinnedStore({ storage: area, pageKey: 'p2' });
    await a.save({ id: 'x', kind: 'explain', html: 'hi' });
    await b.save({ id: 'y', kind: 'explain', html: 'yo' });
    expect((await a.load()).map((e) => e.id)).toEqual(['x']);
    expect((await b.load()).map((e) => e.id)).toEqual(['y']);
    await a.remove('x');
    expect(await a.load()).toEqual([]);
    expect((await b.load()).length).toBe(1);
  });

  it('saving the same card again replaces it', async () => {
    const s = createPinnedStore({ storage: fakeArea(), pageKey: 'p' });
    await s.save({ id: 'x', kind: 'k', html: 'one' });
    await s.save({ id: 'x', kind: 'k', html: 'two' });
    const list = await s.load();
    expect(list.length).toBe(1);
    expect(list[0].html).toBe('two');
  });

  it('keeps at most a few cards per page and a bounded number of pages', async () => {
    const area = fakeArea();
    const s = createPinnedStore({ storage: area, pageKey: 'p' });
    for (let i = 0; i < MAX_PER_PAGE + 3; i++) await s.save({ id: 'c' + i, kind: 'k', html: 'h' });
    expect((await s.load()).length).toBe(MAX_PER_PAGE);
    let t = 0;
    for (let i = 0; i < MAX_PAGES + 5; i++) await createPinnedStore({ storage: area, pageKey: 'page' + i, now: () => ++t }).save({ id: 'z', kind: 'k', html: 'h' });
    expect(Object.keys(area.data.sra_pinned_cards).length).toBeLessThanOrEqual(MAX_PAGES);
    expect((await createPinnedStore({ storage: area, pageKey: 'page' + (MAX_PAGES + 4) }).load()).length).toBe(1); // newest kept
  });

  it('ignores malformed stored entries and works with no storage at all', async () => {
    const area = fakeArea();
    area.data.sra_pinned_cards = { p: [null, { id: 3 }, { id: 'ok', kind: 'k' }] };
    expect((await createPinnedStore({ storage: area, pageKey: 'p' }).load()).map((e) => e.id)).toEqual(['ok']);
    const none = createPinnedStore({ storage: null, pageKey: 'p' });
    await none.save({ id: 'x', kind: 'k' });
    expect(await none.load()).toEqual([]);
  });
});
