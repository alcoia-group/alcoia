import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isReadingTab, pickReadingTab, sendToReadingTab } from '../alcoia/src/shared/reading-tab.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const html = read('alcoia/src/popup/settings.html');
const js = read('alcoia/src/popup/settings.js');
const content = read('alcoia/src/content/content.js');

describe('reading-tab', () => {
  const tabs = [
    { id: 1, url: 'chrome-extension://abc/src/popup/settings.html', lastAccessed: 900 },
    { id: 2, url: 'https://en.wikipedia.org/wiki/Entropy', lastAccessed: 100 },
    { id: 3, url: 'https://example.com/article', lastAccessed: 500 },
    { id: 4, url: 'about:blank', lastAccessed: 800 },
    { id: 5, url: 'file:///home/me/notes.html', lastAccessed: 300 },
  ];

  it('skips extension and browser pages and picks the page used most recently', () => {
    expect(isReadingTab(tabs[0])).toBe(false);
    expect(isReadingTab(tabs[3])).toBe(false);
    expect(pickReadingTab(tabs).id).toBe(3);
    expect(pickReadingTab([tabs[0], tabs[3]])).toBeNull();
    expect(pickReadingTab(undefined)).toBeNull();
  });

  it('sends the message to that page and reports success', async () => {
    const chromeApi = {
      runtime: {},
      tabs: {
        query: vi.fn((_q, cb) => cb(tabs)),
        sendMessage: vi.fn((_id, _m, cb) => cb({ status: 'ok' })),
      },
    };
    const result = await sendToReadingTab(chromeApi, { action: 'sessionRecall' });
    expect(result).toEqual({ ok: true, response: { status: 'ok' }, tabId: 3 });
    expect(chromeApi.tabs.sendMessage).toHaveBeenCalledWith(3, { action: 'sessionRecall' }, expect.any(Function));
  });

  it('reports no page, and an unreachable page, without throwing', async () => {
    const none = { runtime: {}, tabs: { query: (_q, cb) => cb([tabs[0]]), sendMessage: vi.fn() } };
    expect(await sendToReadingTab(none, { action: 'showReceipt' })).toEqual({ ok: false, reason: 'no_page' });
    expect(none.tabs.sendMessage).not.toHaveBeenCalled();
    const closed = { runtime: { lastError: { message: 'no receiver' } }, tabs: { query: (_q, cb) => cb(tabs), sendMessage: (_i, _m, cb) => cb(undefined) } };
    expect(await sendToReadingTab(closed, { action: 'showReceipt' })).toEqual({ ok: false, reason: 'unreachable' });
    const broken = { tabs: { query: () => { throw new Error('x'); } } };
    expect(await sendToReadingTab(broken, {})).toEqual({ ok: false, reason: 'unreachable' });
  });
});

describe('settings page: Recall and Receipt', () => {
  it('has both buttons', () => {
    expect(html).toMatch(/id="recallBtn"[^>]*>Recall</);
    expect(html).toMatch(/id="receiptBtn"[^>]*>Receipt</);
  });

  it('sends the same messages the page handles for Alt+R and Alt+I', () => {
    expect(js).toMatch(/recallBtn'\), \{ action: 'sessionRecall' \}/);
    expect(js).toMatch(/receiptBtn'\), \{ action: 'showReceipt' \}/);
    // content.js: the same two functions the keyboard shortcuts call.
    expect(content).toMatch(/msg\.action === 'sessionRecall'[\s\S]{0,120}runSessionRecall/);
    expect(content).toMatch(/msg\.action === 'showReceipt'[\s\S]{0,80}showReceipt\(\)/);
    expect(content).toMatch(/e\.key === 'r'[\s\S]{0,80}runSessionRecall\(\)/);
    expect(content).toMatch(/e\.key === 'i'[\s\S]{0,80}showReceipt\(\)/);
  });
});

describe('settings page: new switches and wording', () => {
  it('"Explain on highlight" is on by default, stored as sra_explain_on_highlight, and broadcast', () => {
    expect(html).toMatch(/id="explainOnHighlightToggle" checked/);
    expect(html).toContain('Explain on highlight');
    const defaults = js.slice(js.indexOf('const DEFAULTS'), js.indexOf('};', js.indexOf('const DEFAULTS')));
    expect(defaults).toMatch(/sra_explain_on_highlight:\s*true/);
    expect(js).toMatch(/explainOnHighlightToggle\.checked\s*=\s*res\.sra_explain_on_highlight\s*!==\s*false/);
    expect(js).toMatch(/sra_explain_on_highlight:\s*explainOnHighlightToggle\.checked/);
    expect(js).toMatch(/explainOnHighlight:\s*s\.sra_explain_on_highlight/);
  });

  it('"Show connections to my documents" is on by default and stored', () => {
    expect(html).toMatch(/id="showConnectionsToggle" checked/);
    expect(html).toContain('Show connections to my documents');
    const defaults = js.slice(js.indexOf('const DEFAULTS'), js.indexOf('};', js.indexOf('const DEFAULTS')));
    expect(defaults).toMatch(/sra_show_connections:\s*true/);
    expect(js).toMatch(/sra_show_connections:\s*showConnectionsToggle\.checked/);
  });

  it('makes no claim about interruptions that is not implemented', () => {
    expect(html).not.toMatch(/slower hand/);
    expect(html).not.toMatch(/cushion/);
    expect(html).not.toMatch(/Uses one assist/);
  });

  it('names the PDF and PowerPoint setting in full and keeps one name for keeping cards open', () => {
    expect(html).toContain('Open local PDF and PowerPoint files in alcoia');
    expect(html).not.toMatch(/PDF\/PPTX/);
    expect(html).toContain('Keep cards until I close them');
    expect(html).not.toMatch(/Pin by default/);
  });

  it('lists Ctrl+drag as highlight and explain', () => {
    expect(html).toMatch(/<kbd>Ctrl\+drag<\/kbd><span class="kbd-desc">Highlight the selection and explain it/);
  });
});

describe('content.js: explain on highlight', () => {
  it('reads the setting at start, from the settings message, and live from storage', () => {
    expect(content).toMatch(/sra_explain_on_highlight:\s*true/);
    expect(content).toMatch(/explainOnHighlightEnabled\s*=\s*res\.sra_explain_on_highlight\s*!==\s*false/);
    expect(content).toMatch(/msg\.explainOnHighlight\s*!==\s*undefined/);
    expect(content).toMatch(/changes\.sra_explain_on_highlight/);
  });

  it('shows the explanation for a new highlight when it is on, and saves it only when asked to', () => {
    const fn = content.slice(content.indexOf('async function applyTextHighlight'), content.indexOf('function deleteTextHighlight'));
    expect(fn).toMatch(/if \(highlightSummarizeEnabled \|\| explainOnHighlightEnabled\)/);
    expect(fn).toMatch(/fetchSummary\(text, mode\)/);
    expect(fn).toMatch(/renderPopup\(anchorRect/);
    expect(fn).toMatch(/if \(highlightSummarizeEnabled && highlightPersistEnabled\) saveHighlightExplanation/);
  });
});
