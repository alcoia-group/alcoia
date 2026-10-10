import { describe, it, expect } from 'vitest';
import { makeEntry, addEntry, MAX_ENTRIES, MAX_TEXT } from '../alcoia/src/shared/popup-history.js';

describe('popup history', () => {
  it('trims text, keeps host only and ignores empty popups', () => {
    const e = makeEntry({ text: `  hello   world ${'x'.repeat(2000)}`, host: 'example.com', kind: 'question', now: 1 });
    expect(e.text.length).toBe(MAX_TEXT);
    expect(e.host).toBe('example.com');
    expect(e.kind).toBe('question');
    expect(makeEntry({ text: '   ', host: 'a' })).toBeNull();
  });
  it('is newest first, capped, and does not repeat the newest entry', () => {
    let list = [];
    for (let i = 0; i < MAX_ENTRIES + 10; i++) list = addEntry(list, makeEntry({ text: `p${i}`, host: 'h', now: i }));
    expect(list).toHaveLength(MAX_ENTRIES);
    expect(list[0].text).toBe(`p${MAX_ENTRIES + 9}`);
    const same = addEntry(list, makeEntry({ text: list[0].text, host: 'h' }));
    expect(same).toBe(list);
  });
});
