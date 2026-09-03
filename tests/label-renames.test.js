/* Item 34: several popup labels described the mechanism rather than what
 * the reader gets. Storage keys are unchanged — only the visible label text
 * moved. This pins the renames directly and the one real bug alongside
 * them: "Pin by default" (keep cards open) and "Auto-dismiss" (clear cards
 * on a timer) used to be two independent switches that could both be on at
 * once, which was meaningless. ui-controller.js's resetAutohide() already
 * treats a pinned card as never eligible for the timer — pin already won
 * in code — so the fix here is structural: the UI must not let a reader
 * enter the contradictory state in the first place.
 *
 * Item 15a-1: every toggle these tests cover (comprehension, pin/autohide,
 * focus ruler, highlight summarise) moved from popup.html/popup.js to the
 * new settings.html/settings.js — the popup itself now only shows the
 * master on/off switch. Re-pointed at the new files; every assertion below
 * is unchanged from what it checked in popup.html/popup.js. */
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
  const settingsHtml = read('alcoia/src/popup/settings.html');

  it.each(RENAMES)('renames %j to %j in settings.html', (oldLabel, newLabel) => {
    expect(settingsHtml, `settings.html should not contain the old label "${oldLabel}"`).not.toContain(`>${oldLabel}<`);
    expect(settingsHtml, `settings.html should contain the new label "${newLabel}"`).toContain(newLabel);
  });

  it('never uses the word "telemetry" in any visible label or description', () => {
    // Strips HTML comments first — item 35, not this item, is responsible
    // for the one remaining comment mentioning it; this item's own scope is
    // reader-visible copy only.
    const visibleOnly = settingsHtml.replace(/<!--[\s\S]*?-->/g, '');
    expect(visibleOnly.toLowerCase()).not.toContain('telemetry');
  });

  it('does not change any storage key', () => {
    for (const key of [
      'sra_comprehension', 'sra_selection', 'sra_highlight_para',
      'sra_pin_default', 'sra_autohide', 'sra_focus_ruler', 'sra_highlight_summarize',
    ]) {
      expect(settingsHtml + read('alcoia/src/popup/settings.js'), `${key} should still be referenced`).toContain(key);
    }
  });

  it('unchanged labels stay unchanged', () => {
    for (const label of ['Highlight colour', 'Read aloud', 'Dark mode']) {
      expect(settingsHtml).toContain(label);
    }
  });
});

describe('the pin/auto-dismiss contradiction cannot be entered (item 34)', () => {
  const settingsJs = read('alcoia/src/popup/settings.js');

  it('turning on "keep cards" forces "clear automatically" off and disables it', () => {
    expect(settingsJs).toMatch(/function syncPinAutohideExclusivity/);
    expect(settingsJs).toMatch(/autohideToggle\.disabled\s*=\s*pinDefaultToggle\.checked/);
    expect(settingsJs).toMatch(/pinDefaultToggle\.checked\s*&&\s*autohideToggle\.checked/);
  });

  it('pinDefaultToggle has its own change handler that re-syncs exclusivity', () => {
    expect(settingsJs).toMatch(/pinDefaultToggle\.addEventListener\('change',\s*\(\)\s*=>\s*\{\s*\n\s*syncPinAutohideExclusivity\(\)/);
  });

  it('the sync runs on initial load, so a pre-existing contradictory install self-corrects', () => {
    // settings.js extracts the load callback into a named paint(res) function
    // (reused for the initial load AND the chrome.storage.onChanged
    // repaint) rather than inlining it directly in the .get() call the way
    // popup.js used to — so the assertion checks paint() itself contains the
    // sync call, and that paint is what the initial load actually passes.
    expect(settingsJs).toMatch(/chrome\.storage\.local\.get\(DEFAULTS,\s*paint\)/);
    const paintBlock = settingsJs.slice(settingsJs.indexOf('function paint('), settingsJs.indexOf('\nchrome.storage.local.get(DEFAULTS'));
    expect(paintBlock).toMatch(/syncPinAutohideExclusivity\(\)/);
  });

  it('mode presets re-sync exclusivity too, and no preset already contradicts itself', () => {
    expect(settingsJs).toMatch(/function applyMode[\s\S]{0,800}syncPinAutohideExclusivity\(\)/);
    const modesBlock = settingsJs.match(/const MODES = \{[\s\S]*?\n  \};/)?.[0] || '';
    for (const line of modesBlock.split('\n').filter((l) => l.includes('sra_pin_default'))) {
      const pinOn      = /sra_pin_default:\s*true/.test(line);
      const autohideOn = /sra_autohide:\s*true/.test(line);
      expect(pinOn && autohideOn, `a mode preset should not set both: ${line.trim()}`).toBe(false);
    }
  });
});
