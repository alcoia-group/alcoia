/* Item 34: several popup labels described the mechanism rather than what
 * the reader gets. Storage keys are unchanged — only the visible label text
 * moved. This pins the renames directly and the one real bug alongside
 * them: "Pin by default" (keep cards open) and "Auto-dismiss" (clear cards
 * on a timer) used to be two independent switches that could both be on at
 * once, which was meaningless. ui-controller.js's resetAutohide() already
 * treats a pinned card as never eligible for the timer — pin already won
 * in code — so the fix here is structural: the UI must not let a reader
 * enter the contradictory state in the first place. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const RENAMES = [
  ['Reading signals', "Notice when I'm struggling"],
  ['Selection summaries', 'Explain text I select'],
  ['Show the passage', 'Outline the paragraph'],
  ['Pin by default', 'Keep cards until I close them'],
  ['Auto-dismiss', 'Clear cards automatically'],
  ['Focus ruler', 'Reading guide'],
  ['Summarise on highlight', 'Save an explanation with each highlight'],
];

describe('popup label renames (item 34)', () => {
  const popupHtml = read('alcoia/src/popup/popup.html');

  it.each(RENAMES)('renames %j to %j in popup.html', (oldLabel, newLabel) => {
    expect(popupHtml, `popup.html should not contain the old label "${oldLabel}"`).not.toContain(`>${oldLabel}<`);
    expect(popupHtml, `popup.html should contain the new label "${newLabel}"`).toContain(newLabel);
  });

  it('never uses the word "telemetry" in any visible label or description', () => {
    // Strips HTML comments first — item 35, not this item, is responsible
    // for the one remaining comment mentioning it; this item's own scope is
    // reader-visible copy only.
    const visibleOnly = popupHtml.replace(/<!--[\s\S]*?-->/g, '');
    expect(visibleOnly.toLowerCase()).not.toContain('telemetry');
  });

  it('does not change any storage key', () => {
    for (const key of [
      'sra_comprehension', 'sra_selection', 'sra_highlight_para',
      'sra_pin_default', 'sra_autohide', 'sra_focus_ruler', 'sra_highlight_summarize',
    ]) {
      expect(popupHtml + read('alcoia/src/popup/popup.js'), `${key} should still be referenced`).toContain(key);
    }
  });

  it('unchanged labels stay unchanged', () => {
    for (const label of ['Highlight colour', 'Read aloud', 'Dark mode']) {
      expect(popupHtml).toContain(label);
    }
  });
});

describe('the pin/auto-dismiss contradiction cannot be entered (item 34)', () => {
  const popupJs = read('alcoia/src/popup/popup.js');

  it('turning on "keep cards" forces "clear automatically" off and disables it', () => {
    expect(popupJs).toMatch(/function syncPinAutohideExclusivity/);
    expect(popupJs).toMatch(/autohideToggle\.disabled\s*=\s*pinDefaultToggle\.checked/);
    expect(popupJs).toMatch(/pinDefaultToggle\.checked\s*&&\s*autohideToggle\.checked/);
  });

  it('pinDefaultToggle has its own change handler that re-syncs exclusivity', () => {
    expect(popupJs).toMatch(/pinDefaultToggle\.addEventListener\('change',\s*\(\)\s*=>\s*\{\s*\n\s*syncPinAutohideExclusivity\(\)/);
  });

  it('the sync runs on initial load, so a pre-existing contradictory install self-corrects', () => {
    const loadBlock = popupJs.slice(popupJs.indexOf('chrome.storage.local.get(DEFAULTS'), popupJs.indexOf('chrome.storage.local.get(DEFAULTS') + 1200);
    expect(loadBlock).toMatch(/syncPinAutohideExclusivity\(\)/);
  });

  it('mode presets re-sync exclusivity too, and no preset already contradicts itself', () => {
    expect(popupJs).toMatch(/function applyMode[\s\S]{0,800}syncPinAutohideExclusivity\(\)/);
    const modesBlock = popupJs.match(/const MODES = \{[\s\S]*?\n  \};/)?.[0] || '';
    for (const line of modesBlock.split('\n').filter((l) => l.includes('sra_pin_default'))) {
      const pinOn      = /sra_pin_default:\s*true/.test(line);
      const autohideOn = /sra_autohide:\s*true/.test(line);
      expect(pinOn && autohideOn, `a mode preset should not set both: ${line.trim()}`).toBe(false);
    }
  });
});
