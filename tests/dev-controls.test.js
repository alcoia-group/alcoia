/* Item 33: two developer-only controls used to ship in the reader-facing
 * popup — four state-simulator buttons (a reader clicking "struggling" gets
 * an interruption they did not earn) and an editable backend-URL field (a
 * reader editing it can only break their own install once a real origin is
 * configured). Both moved to the diagnostics page, gated on the pre-existing
 * sra_debug setting rather than a new hidden surface. This guards against
 * either reappearing in the main popup, and confirms the underlying
 * mechanism — runSimulatedState(), the simulateState message, the Alt+1–5
 * shortcuts — is untouched, since that is what tests/browser/smoke.mjs
 * actually exercises (via a real Alt+Digit1 keypress on the page, never via
 * these buttons at all). */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('developer controls are out of the reader-facing popup (item 33)', () => {
  const popupHtml = read('alcoia/src/popup/popup.html');
  const popupJs   = read('alcoia/src/popup/popup.js');

  it('popup.html has no state-simulator button', () => {
    for (const id of ['simStrugglingBtn', 'simDriftingBtn', 'simSkimmingBtn', 'simOnPaceBtn']) {
      expect(popupHtml, `popup.html should not contain #${id}`).not.toContain(`id="${id}"`);
    }
  });

  it('popup.html has no backend-URL input', () => {
    expect(popupHtml).not.toContain('id="backendUrl"');
    expect(popupHtml).not.toMatch(/<input[^>]*id="backendUrl"/);
  });

  it('popup.js has no simulate-button wiring or backendUrlInput element', () => {
    for (const id of ['simStrugglingBtn', 'simDriftingBtn', 'simSkimmingBtn', 'simOnPaceBtn']) {
      expect(popupJs, `popup.js should not reference #${id}`).not.toContain(id);
    }
    expect(popupJs).not.toContain('backendUrlInput');
  });

  it('the simulate mechanism itself survives, moved to the diagnostics page', () => {
    const contentJs = read('alcoia/src/content/content.js');
    expect(contentJs).toContain('function runSimulatedState');
    expect(contentJs).toMatch(/msg\.type === 'simulateState'/);

    const diagHtml = read('alcoia/src/popup/diagnostics.html');
    const diagJs   = read('alcoia/src/popup/diagnostics.js');
    for (const id of ['simStrugglingBtn', 'simDriftingBtn', 'simSkimmingBtn', 'simOnPaceBtn']) {
      expect(diagHtml, `diagnostics.html should contain #${id}`).toContain(`id="${id}"`);
      expect(diagJs, `diagnostics.js should wire #${id}`).toContain(id);
    }
    expect(diagJs).toMatch(/type:\s*'simulateState'/);
  });

  it('the backend-URL override survives, moved to the diagnostics page', () => {
    const diagHtml = read('alcoia/src/popup/diagnostics.html');
    const diagJs   = read('alcoia/src/popup/diagnostics.js');
    expect(diagHtml).toContain('id="devBackendUrl"');
    expect(diagJs).toContain('devBackendUrl');
    expect(diagJs).toMatch(/sra_backend_url/);
  });

  it('the diagnostics developer card is gated on sra_debug, not always shown', () => {
    const diagHtml = read('alcoia/src/popup/diagnostics.html');
    const diagJs   = read('alcoia/src/popup/diagnostics.js');
    expect(diagHtml).toMatch(/id="devCard"[^>]*hidden/);
    expect(diagJs).toMatch(/sra_debug/);
    expect(diagJs).toMatch(/devCard'\)\.hidden\s*=\s*!res\.sra_debug/);
  });
});
