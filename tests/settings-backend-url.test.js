/* The Backend URL field used to live on the dedicated settings page
 * (settings.html/settings.js, item 15a-1) as an "Advanced" toggle reveal —
 * a development convenience for pointing at a local server, confusing and
 * potentially harmful for a real reader now that config.js's default is
 * the real production origin. Removed from this page entirely; the
 * developer-only equivalent stays on the diagnostics page, gated on
 * sra_debug (tests/dev-controls.test.js covers that one).
 *
 * The runtime override mechanism itself (sra_backend_url read from
 * storage, overriding config.js's default) is deliberately NOT removed —
 * only this page's UI for editing it. Same shape as dev-controls.test.js's
 * own assertions: reads the real source files as text, since these are
 * "is this control present/absent" checks, not behavioural ones. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('settings page has no Backend URL field (item: remove dev convenience from settings UI)', () => {
  const settingsHtml = read('alcoia/src/popup/settings.html');
  const settingsJs   = read('alcoia/src/popup/settings.js');

  it('settings.html has no Backend URL input, label, or the "Advanced" reveal that only ever held it', () => {
    expect(settingsHtml).not.toContain('id="backendUrlInput"');
    expect(settingsHtml).not.toMatch(/<input[^>]*id="backendUrlInput"/);
    expect(settingsHtml).not.toMatch(/>\s*Backend URL\s*</);
    // The "Advanced ▾" toggle and the div it revealed held nothing else —
    // removing the field left them as a button that opens an empty box,
    // which is its own confusing dead UI, so both went with it.
    expect(settingsHtml).not.toContain('id="advancedToggle"');
    expect(settingsHtml).not.toContain('id="accountAdvanced"');
    expect(settingsHtml).not.toContain('Advanced ▾');
  });

  it('settings.html has no leftover CSS for the removed toggle/reveal', () => {
    expect(settingsHtml).not.toContain('.advanced-toggle');
    expect(settingsHtml).not.toContain('#accountAdvanced');
  });

  it('settings.js has no element lookups or listeners for the removed controls', () => {
    expect(settingsJs).not.toContain('backendUrlInput');
    expect(settingsJs).not.toContain('advancedToggle');
    expect(settingsJs).not.toContain("$('accountAdvanced')");
  });

  it('settings.js\'s load/reset defaults no longer include sra_backend_url', () => {
    const defaultsBlock = settingsJs.slice(
      settingsJs.indexOf('const DEFAULTS'),
      settingsJs.indexOf('};', settingsJs.indexOf('const DEFAULTS')),
    );
    expect(defaultsBlock).not.toMatch(/sra_backend_url/);
  });

  it('saveAndBroadcast() never WRITES sra_backend_url — only forwards the current value', () => {
    const fnStart = settingsJs.indexOf('function saveAndBroadcast');
    const fnBody = settingsJs.slice(fnStart, settingsJs.indexOf('\n}', fnStart));
    // The object passed to chrome.storage.local.set(s) — everything this
    // function actually SAVES — must not include the key at all.
    const setBlock = fnBody.slice(fnBody.indexOf('const s = {'), fnBody.indexOf('chrome.storage.local.set(s)'));
    expect(setBlock).not.toMatch(/sra_backend_url\s*:/);
  });

  /* The one deliberately-kept reference: settings.js still READS
   * sra_backend_url once, inside saveAndBroadcast(), to forward whatever
   * value is currently stored (set, if ever, from the diagnostics page)
   * into the 'settings' broadcast every other toggle change already
   * sends — the only way a diagnostics-set backend URL reaches an
   * already-open tab without a reload. This is the "runtime override
   * mechanism stays functional, just invisible" requirement, not a leftover
   * of the removed field. */
  it('the storage read that forwards the current backend URL into the settings broadcast still exists', () => {
    expect(settingsJs).toMatch(/chrome\.storage\.local\.get\(\{\s*sra_backend_url:/);
    expect(settingsJs).toMatch(/backendUrl:\s*r\.sra_backend_url/);
  });
});
