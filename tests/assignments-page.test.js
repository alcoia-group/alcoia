// @vitest-environment jsdom
/* assignments.js — the Assignments entry point (item S6/E4 follow-up).
 * Loads the REAL assignments.html body into jsdom, same reasoning as
 * tests/join-class.test.js and tests/upgrade.test.js: assignments.js does
 * plain document.getElementById lookups at module top level and would
 * throw on a missing element, which is exactly the guard this buys.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSIGNMENTS_HTML_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'alcoia', 'src', 'popup', 'assignments.html',
);

const MINE_URL = 'https://api.alcoia.invalid/api/assignments/mine';
const DOCUMENTS_URL = 'https://api.alcoia.invalid/api/documents';
const ASSIGNMENTS_URL = 'https://api.alcoia.invalid/api/assignments';
const READER_ORIGIN = 'https://reader.alcoia.invalid';

function loadAssignmentsBody() {
  const html = fs.readFileSync(ASSIGNMENTS_HTML_PATH, 'utf8');
  const match = html.match(/<body>([\s\S]*)<\/body>/);
  if (!match) throw new Error('assignments.html body not found — did its structure change?');
  document.body.innerHTML = match[1].replace(/<script[\s\S]*?<\/script>/g, '');
  window.history.pushState({}, '', '/assignments.html');
}

function fakeChrome(seed = {}) {
  const store = { ...seed };
  const tabsCreated = [];
  return {
    storage: {
      local: {
        get(keys, cb) {
          const result = {};
          for (const [k, def] of Object.entries(keys || {})) result[k] = k in store ? store[k] : def;
          cb(result);
        },
        set(obj, cb) { Object.assign(store, obj); if (cb) cb(); },
      },
    },
    tabs: { create: (opts) => { tabsCreated.push(opts); } },
    runtime: { getURL: (p) => 'chrome-extension://test/' + p, lastError: undefined },
    _store: store,
    _tabsCreated: tabsCreated,
  };
}

function fakeConfig() {
  return {
    SUMMARIZE_URL: 'https://api.alcoia.invalid/api/summarize',
    SESSION_STORAGE_KEY: 'sra_session',
    ASSIGNMENTS_MINE_URL: MINE_URL,
    ASSIGNMENTS_URL,
    READER_ORIGIN,
    DOCUMENTS_URL,
  };
}

function routedFetch(routes) {
  return vi.fn(async (url, init) => {
    for (const [match, handler] of routes) {
      if (url.includes(match)) return handler(url, init);
    }
    throw new Error('unexpected fetch to ' + url);
  });
}

async function importFreshAssignmentsJs() {
  const url = '../alcoia/src/popup/assignments.js?t=' + Date.now() + Math.random();
  await import(/* @vite-ignore */ url);
}

const VALID_SESSION = { token: 'tok-1', email: 'reader@example.com', expiresAt: Date.now() + 999_999 };

describe('a student with an active assignment sees it listed; one without sees none', () => {
  it('renders className and closesAt for each returned assignment, hides the empty state', async () => {
    loadAssignmentsBody();
    vi.stubGlobal('chrome', fakeChrome({ sra_session: VALID_SESSION }));
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([[MINE_URL, async () => ({
      ok: true,
      json: async () => ({
        assignments: [{
          assignmentId: 'a1', classId: 'c1', className: 'Reading 101', closesAt: '2099-01-01T00:00:00Z',
          documents: [{ documentId: 'd1', format: 'pdf', status: 'accepted' }],
        }],
      }),
    })]]));

    await importFreshAssignmentsJs();
    await vi.waitFor(() => expect(document.getElementById('assignList').hidden).toBe(false));

    expect(document.getElementById('emptyState').hidden).toBe(true);
    const row = document.querySelector('.assign-row');
    expect(row.textContent).toContain('Reading 101');
    expect(row.querySelector('.assign-row-closes').textContent).toMatch(/closes/i);
    // Never a countdown — CLAUDE.md / ALCOIA-PLATFORM-SPEC.md §7.
    expect(row.querySelector('.assign-row-closes').textContent).not.toMatch(/left|remaining|days?\s*:\s*\d/i);
  });

  it('a student with no assignments sees the honest empty state, not an error or a blank page', async () => {
    loadAssignmentsBody();
    vi.stubGlobal('chrome', fakeChrome({ sra_session: VALID_SESSION }));
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([[MINE_URL, async () => ({ ok: true, json: async () => ({ assignments: [] }) })]]));

    await importFreshAssignmentsJs();
    await vi.waitFor(() => expect(document.getElementById('emptyState').hidden).toBe(false));
    expect(document.getElementById('assignList').hidden).toBe(true);
    expect(document.getElementById('pageError').hidden).toBe(true);
  });

  it('signed out shows an honest sign-in prompt, never an empty list or a crash', async () => {
    loadAssignmentsBody();
    vi.stubGlobal('chrome', fakeChrome({})); // no sra_session
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);

    await importFreshAssignmentsJs();
    await vi.waitFor(() => expect(document.getElementById('pageError').hidden).toBe(false));
    expect(document.getElementById('pageError').textContent).toMatch(/sign in/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('opening a PDF assignment loads it through the existing viewer, sourced remotely', () => {
  it('clicking Open fetches the signed download URL and opens viewer.html with it, plus the assignmentId and a title', async () => {
    loadAssignmentsBody();
    const chrome = fakeChrome({ sra_session: VALID_SESSION });
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([
      [MINE_URL, async () => ({
        ok: true,
        json: async () => ({
          assignments: [{
            assignmentId: 'a1', classId: 'c1', className: 'Reading 101', closesAt: '2099-01-01T00:00:00Z',
            documents: [{ documentId: 'd1', format: 'pdf', status: 'accepted' }],
          }],
        }),
      })],
      [`${DOCUMENTS_URL}/d1/download-url`, async () => ({
        ok: true,
        json: async () => ({ url: 'https://storage.example/orgs/x/assignments/a1/uuid.pdf?X-Amz-Signature=abc', expiresInSeconds: 900 }),
      })],
    ]));

    await importFreshAssignmentsJs();
    await vi.waitFor(() => expect(document.querySelector('.assign-row')).toBeTruthy());

    const openBtn = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Open');
    expect(openBtn).toBeTruthy();
    openBtn.click();

    await vi.waitFor(() => expect(chrome._tabsCreated.length).toBe(1));
    const openedUrl = chrome._tabsCreated[0].url;
    expect(openedUrl).toContain('chrome-extension://test/src/pdf-viewer/viewer.html');
    expect(openedUrl).toContain('src=' + encodeURIComponent('https://storage.example/orgs/x/assignments/a1/uuid.pdf?X-Amz-Signature=abc'));
    expect(openedUrl).toContain('assignmentId=a1');
    expect(openedUrl).toContain('title=' + encodeURIComponent('Reading 101'));
  });

  it('a failed download-url fetch shows an honest error, never opens a broken tab', async () => {
    loadAssignmentsBody();
    const chrome = fakeChrome({ sra_session: VALID_SESSION });
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([
      [MINE_URL, async () => ({
        ok: true,
        json: async () => ({ assignments: [{ assignmentId: 'a1', classId: 'c1', className: 'X', closesAt: '2099-01-01T00:00:00Z', documents: [{ documentId: 'd1', format: 'pdf', status: 'accepted' }] }] }),
      })],
      [`${DOCUMENTS_URL}/d1/download-url`, async () => ({ ok: false, status: 403, json: async () => ({ error: 'not_authorized' }) })],
    ]));

    await importFreshAssignmentsJs();
    await vi.waitFor(() => expect(document.querySelector('.assign-row')).toBeTruthy());
    const openBtn = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Open');
    openBtn.click();

    await vi.waitFor(() => expect(document.getElementById('pageError').hidden).toBe(false));
    expect(chrome._tabsCreated).toEqual([]);
  });
});

const oneAssignment = (documents) => async () => ({
  ok: true,
  json: async () => ({ assignments: [{ assignmentId: 'a1', classId: 'c1', className: 'Slides 101', closesAt: '2099-01-01T00:00:00Z', documents }] }),
});

describe('opening in the web reader', () => {
  it('a pptx opens in the reader with a one-time code in the URL fragment', async () => {
    loadAssignmentsBody();
    const chrome = fakeChrome({ sra_session: VALID_SESSION });
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    const fetchMock = routedFetch([
      [MINE_URL, oneAssignment([{ documentId: 'd1', format: 'pptx', status: 'accepted' }])],
      [`${ASSIGNMENTS_URL}/a1/reader-handoff`, async () => ({ ok: true, status: 201, json: async () => ({ code: 'c0de+/=', expiresAt: '2099-01-01T00:00:00Z' }) })],
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await importFreshAssignmentsJs();
    await vi.waitFor(() => expect(document.querySelector('.assign-row')).toBeTruthy());
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Open').click();

    await vi.waitFor(() => expect(chrome._tabsCreated.length).toBe(1));
    const url = chrome._tabsCreated[0].url;
    expect(url).toBe(`${READER_ORIGIN}/a/a1#c=${encodeURIComponent('c0de+/=')}`);
    // the code is in the fragment, never a query string
    expect(url).not.toContain('?');
    const handoffCall = fetchMock.mock.calls.find(([u]) => u.endsWith('/reader-handoff'));
    expect(handoffCall[1].method).toBe('POST');
    expect(handoffCall[1].headers.Authorization).toBe('Bearer tok-1');
  });

  it('a docx also opens in the reader, even with a stale unsupported status', async () => {
    loadAssignmentsBody();
    const chrome = fakeChrome({ sra_session: VALID_SESSION });
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([
      [MINE_URL, oneAssignment([{ documentId: 'd1', format: 'docx', status: 'unsupported' }])],
      [`${ASSIGNMENTS_URL}/a1/reader-handoff`, async () => ({ ok: true, status: 201, json: async () => ({ code: 'x' }) })],
    ]));
    await importFreshAssignmentsJs();
    await vi.waitFor(() => expect(document.querySelector('.assign-row')).toBeTruthy());
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Open').click();
    await vi.waitFor(() => expect(chrome._tabsCreated.length).toBe(1));
    expect(chrome._tabsCreated[0].url).toMatch(/^https:\/\/reader\.alcoia\.invalid\/a\/a1#c=/);
  });

  it('a pdf falls back to the extension viewer when the reader handoff is not available', async () => {
    loadAssignmentsBody();
    const chrome = fakeChrome({ sra_session: VALID_SESSION });
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([
      [MINE_URL, oneAssignment([{ documentId: 'd1', format: 'pdf', status: 'accepted' }])],
      [`${ASSIGNMENTS_URL}/a1/reader-handoff`, async () => ({ ok: false, status: 404, json: async () => ({ error: 'assignment_not_found' }) })],
      [`${DOCUMENTS_URL}/d1/download-url`, async () => ({ ok: true, json: async () => ({ url: 'https://storage.example/x.pdf?sig=1', expiresInSeconds: 900 }) })],
    ]));
    await importFreshAssignmentsJs();
    await vi.waitFor(() => expect(document.querySelector('.assign-row')).toBeTruthy());
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Open').click();
    await vi.waitFor(() => expect(chrome._tabsCreated.length).toBe(1));
    expect(chrome._tabsCreated[0].url).toContain('src/pdf-viewer/viewer.html');
  });

  it('a pptx whose handoff fails shows an error and opens nothing', async () => {
    loadAssignmentsBody();
    const chrome = fakeChrome({ sra_session: VALID_SESSION });
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([
      [MINE_URL, oneAssignment([{ documentId: 'd1', format: 'pptx', status: 'accepted' }])],
      [`${ASSIGNMENTS_URL}/a1/reader-handoff`, async () => ({ ok: false, status: 500, json: async () => ({ error: 'internal_error' }) })],
    ]));
    await importFreshAssignmentsJs();
    await vi.waitFor(() => expect(document.querySelector('.assign-row')).toBeTruthy());
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Open').click();
    await vi.waitFor(() => expect(document.getElementById('pageError').hidden).toBe(false));
    expect(chrome._tabsCreated).toEqual([]);
  });
});

describe('a file type the reader does not show, or no file, says so plainly', () => {
  it('an unknown format shows no Open button and a working Download instead', async () => {
    loadAssignmentsBody();
    const chrome = fakeChrome({ sra_session: VALID_SESSION });
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([
      [MINE_URL, oneAssignment([{ documentId: 'd1', format: 'odt', status: 'unsupported' }])],
      [`${DOCUMENTS_URL}/d1/download-url`, async () => ({ ok: true, json: async () => ({ url: 'https://storage.example/file.odt?sig=x', expiresInSeconds: 900 }) })],
    ]));
    await importFreshAssignmentsJs();
    await vi.waitFor(() => expect(document.querySelector('.assign-row')).toBeTruthy());
    const row = document.querySelector('.assign-row');
    expect(row.textContent).toMatch(/can't be opened here/i);
    expect([...row.querySelectorAll('button')].some((b) => b.textContent === 'Open')).toBe(false);
    [...row.querySelectorAll('button')].find((b) => b.textContent === 'Download instead').click();
    await vi.waitFor(() => expect(chrome._tabsCreated.length).toBe(1));
    expect(chrome._tabsCreated[0].url).toBe('https://storage.example/file.odt?sig=x');
  });

  it('an assignment with no document uploaded yet shows that honestly too, not a crash or a blank row', async () => {
    loadAssignmentsBody();
    vi.stubGlobal('chrome', fakeChrome({ sra_session: VALID_SESSION }));
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([[MINE_URL, oneAssignment([])]]));
    await importFreshAssignmentsJs();
    await vi.waitFor(() => expect(document.querySelector('.assign-row')).toBeTruthy());
    expect(document.querySelector('.assign-row').textContent).toMatch(/no document uploaded yet/i);
  });
});
