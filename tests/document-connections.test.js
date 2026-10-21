// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  normaliseLabel, foldPlural, matchConnections, cleanDocuments, createDocumentConnections, CACHE_KEY, CACHE_TTL_MS,
} from '../alcoia/src/shared/document-connections.js';
import { createDeviceConcepts } from '../alcoia/src/shared/device-concepts.js';
import { createReadingMap } from '../alcoia/src/content/reading-map.js';

const ORIGIN = 'https://workspace.alcoia.app';
const DOCS = [
  { kind: 'assignment', id: 'a1', title: 'Energy reading', url_path: '/a/a1', concepts: [{ label: 'Gradient descent', description: 'x' }, { label: 'Entropy' }] },
  { kind: 'personal', id: 'p1', title: 'My notes', url_path: '/f/p1', concepts: [{ label: 'Neural network' }, { label: 'it' }, { label: 'SVM' }] },
  { kind: 'assignment', id: 'a2', title: 'Optimisation', url_path: '/a/a2', concepts: [{ label: 'Stochastic gradient descent' }, { label: 'Gradient descent' }] },
];
const ideas = (...labels) => labels.map((label) => ({ key: normaliseLabel(label), label }));

describe('label rules', () => {
  it('normalises case, punctuation and plurals', () => {
    expect(normaliseLabel('  Gradient-Descent! ')).toBe('gradient descent');
    expect(foldPlural('networks')).toBe('network');
    expect(foldPlural('theories')).toBe('theory');
    expect(foldPlural('analysis')).toBe('analysis');
    expect(foldPlural('class')).toBe('class');
  });
});

describe('matchConnections', () => {
  it('matches a plural, links to the workspace and names the idea', () => {
    const out = matchConnections(ideas('neural networks'), DOCS, { workspaceOrigin: ORIGIN });
    expect(out).toEqual([{ documentId: 'p1', kind: 'personal', title: 'My notes', href: `${ORIGIN}/f/p1`, label: 'Neural network', idea: 'neural networks' }]);
  });

  it('finds a document idea inside a longer page idea, but not the reverse', () => {
    expect(matchConnections(ideas('stochastic gradient descent'), [DOCS[0]], { workspaceOrigin: ORIGIN })).toHaveLength(1);
    expect(matchConnections(ideas('descent'), [DOCS[0]], { workspaceOrigin: ORIGIN })).toHaveLength(0);
  });

  it('keeps the longest match per document and orders documents by it', () => {
    const out = matchConnections(ideas('stochastic gradient descent', 'entropy'), DOCS, { workspaceOrigin: ORIGIN });
    expect(out.map((c) => [c.documentId, c.label])).toEqual([['a2', 'Stochastic gradient descent'], ['a1', 'Gradient descent']]);
  });

  it('ignores labels too short to stand on their own, but takes an acronym', () => {
    expect(matchConnections(ideas('it matters'), DOCS, { workspaceOrigin: ORIGIN })).toHaveLength(0);
    expect(matchConnections(ideas('SVM'), DOCS, { workspaceOrigin: ORIGIN })).toHaveLength(1);
  });

  it('returns at most three and refuses a path that is not on the workspace', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ kind: 'assignment', id: `d${i}`, title: `D${i}`, url_path: `/a/d${i}`, concepts: [{ label: 'Entropy' }] }));
    expect(matchConnections(ideas('entropy'), many, { workspaceOrigin: ORIGIN })).toHaveLength(3);
    const bad = [{ id: 'x', title: 'x', url_path: '//evil.example/a', concepts: [{ label: 'Entropy' }] }];
    expect(matchConnections(ideas('entropy'), bad, { workspaceOrigin: ORIGIN })).toHaveLength(0);
    expect(matchConnections([], DOCS)).toEqual([]);
  });

  it('cleans an oversized or malformed response', () => {
    const cleaned = cleanDocuments([{ id: 1, title: 'T'.repeat(500), url_path: '/a/1', concepts: [{ label: 'x'.repeat(500) }, { nope: 1 }] }, { url_path: 'http://x', concepts: [] }, null]);
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0].title.length).toBe(120);
    expect(cleaned[0].concepts).toEqual([{ label: 'x'.repeat(80) }]);
  });
});

function memoryStorage() {
  const data = {};
  return {
    data,
    get: (defaults, cb) => cb({ ...defaults, ...Object.fromEntries(Object.entries(data)) }),
    set: (obj, cb) => { Object.assign(data, obj); cb && cb(); },
    remove: (k, cb) => { delete data[k]; cb && cb(); },
  };
}
const SESSION = { token: 'tok-123', email: 'a@example.com' };
function manager(over = {}) {
  const storage = memoryStorage();
  let clock = 1_000_000;
  const fetchImpl = over.fetchImpl || vi.fn(async () => ({ ok: true, json: async () => ({ documents: DOCS }) }));
  const m = createDocumentConnections({
    getSession: over.getSession || (async () => SESSION),
    hasFeature: over.hasFeature || (async () => true),
    fetchImpl, url: 'https://server.example/api/account/document-concepts',
    storage, now: () => clock, workspaceOrigin: ORIGIN,
  });
  return { m, storage, fetchImpl, advance: (ms) => { clock += ms; } };
}

describe('createDocumentConnections', () => {
  it('asks the server for the account document list only, sending nothing about the page', async () => {
    const { m, fetchImpl } = manager();
    const out = await m.find(ideas('gradient descent', 'a very private page topic'));
    expect(out.map((c) => c.documentId)).toEqual(['a1', 'a2'].filter((id) => out.some((c) => c.documentId === id)));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://server.example/api/account/document-concepts');
    expect(init).toEqual({ method: 'GET', headers: { Authorization: 'Bearer tok-123' } });
    expect(init.body).toBeUndefined();
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toMatch(/private page topic|gradient/i);
  });

  it('caches for a short time and asks again after it', async () => {
    const { m, fetchImpl, storage, advance } = manager();
    await m.find(ideas('entropy'));
    await m.find(ideas('entropy'));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(storage.data[CACHE_KEY].documents.length).toBeGreaterThan(0);
    advance(CACHE_TTL_MS + 1);
    await m.find(ideas('entropy'));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does nothing and stores nothing without the plan, and does not even ask', async () => {
    const { m, fetchImpl, storage } = manager({ hasFeature: async () => false });
    expect(await m.find(ideas('entropy'))).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(storage.data[CACHE_KEY]).toBeUndefined();
  });

  it('does nothing signed out, and drops a copy left by an earlier session', async () => {
    const { m, fetchImpl, storage } = manager({ getSession: async () => null });
    storage.data[CACHE_KEY] = { at: 1, owner: 'someone', documents: DOCS };
    expect(await m.find(ideas('entropy'))).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(storage.data[CACHE_KEY]).toBeUndefined();
  });

  it('does not use another account\'s copy', async () => {
    const { m, fetchImpl, storage } = manager();
    storage.data[CACHE_KEY] = { at: 1_000_000, owner: 'other@example.com', documents: [{ kind: 'assignment', id: 'z', title: 'Z', url_path: '/a/z', concepts: [{ label: 'Entropy' }] }] };
    const out = await m.find(ideas('entropy'));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(out.every((c) => c.documentId !== 'z')).toBe(true);
  });

  it('degrades to nothing on a server error or a network failure', async () => {
    const down = manager({ fetchImpl: vi.fn(async () => { throw new Error('offline'); }) });
    expect(await down.m.find(ideas('entropy'))).toEqual([]);
    const forbidden = manager({ fetchImpl: vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: 'capability_required' }) })) });
    expect(await forbidden.m.find(ideas('entropy'))).toEqual([]);
  });

  it('has no path to learner memory', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const raw = fs.readFileSync(path.resolve(process.cwd(), 'alcoia/src/shared/document-connections.js'), 'utf8');
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/learning-memory|learner-memory|knowledge-state|outcomes/);
  });
});

describe('the ideas on this page (device only)', () => {
  it('pageIdeas lists only ideas that appeared in enough paragraphs of this page load', async () => {
    const dc = createDeviceConcepts({ storage: memoryStorage(), now: () => 1 });
    const text = 'The gradient descent method is widely used. Gradient descent updates weights.';
    await dc.noteRead('p1', text);
    expect(dc.pageIdeas().map((i) => i.key)).not.toContain('gradient descent');
    await dc.noteRead('p2', text);
    await dc.noteRead('p3', text);
    expect(dc.pageIdeas().map((i) => i.key)).toContain('gradient descent');
  });
});

describe('the reading map entry', () => {
  beforeEach(() => { document.body.innerHTML = ''; document.documentElement.lang = 'en'; });

  it('shows a quiet entry with a link and a dot on the tab, and removes both when the list is empty', () => {
    const map = createReadingMap({ sharedStyles: '' });
    map.setConnections([{ title: 'Energy reading', href: `${ORIGIN}/a/a1`, label: 'Entropy', idea: 'entropy' }]);
    map.toggle();
    const host = [...document.querySelectorAll('*')].find((el) => el.shadowRoot?.getElementById('sra-reading-map'));
    const root = host.shadowRoot;
    const link = root.querySelector('a.sra-map-conn');
    expect(link.getAttribute('href')).toBe(`${ORIGIN}/a/a1`);
    expect(link.querySelector('.sra-map-conn-title').textContent).toBe('Connects to Energy reading');
    expect(link.querySelector('.sra-map-conn-idea').textContent).toBe('Idea: Entropy');
    expect(root.getElementById('sra-reading-map-tab').classList.contains('has-connections')).toBe(true);
    expect(root.getElementById('sra-reading-map').classList.contains('open')).toBe(true); // opened only by the toggle above

    map.setConnections([]);
    expect(root.querySelector('a.sra-map-conn')).toBeNull();
    expect(root.getElementById('sra-reading-map-tab').classList.contains('has-connections')).toBe(false);
  });

  it('does not open the map or create anything for an empty list', () => {
    const map = createReadingMap({ sharedStyles: '' });
    map.setConnections([]);
    expect([...document.querySelectorAll('*')].some((el) => el.shadowRoot)).toBe(false);
  });

  it('words the entry in the language of the page', () => {
    document.documentElement.lang = 'fr';
    const map = createReadingMap({ sharedStyles: '' });
    map.setConnections([{ title: 'Énergie', href: `${ORIGIN}/a/a1`, label: 'Entropie', idea: 'entropie' }]);
    map.toggle();
    const host = [...document.querySelectorAll('*')].find((el) => el.shadowRoot?.getElementById('sra-reading-map'));
    expect(host.shadowRoot.querySelector('.sra-map-conn-title').textContent).toBe('Lié à Énergie');
  });
});
