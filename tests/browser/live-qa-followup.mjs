/* Targeted follow-up for two live-qa.mjs results that needed a closer look:
 * T5 (engine said "ACT: ask" twice but no card ever appeared) and T13
 * (tooltip appeared for what was meant to be a plain sentence). Ad hoc,
 * not part of any suite. */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '..', '..', 'dist', 'chrome');
const CHROME = process.env.CHROME || chromium.executablePath();

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tldr-followup-'));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: true, channel: 'chromium',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
});
let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;

async function setStorage(obj) {
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  await p.evaluate((o) => new Promise((r) => chrome.storage.local.set(o, r)), obj);
  await p.close();
}
await setStorage({ sra_enabled: true, sra_comprehension: true, sra_debug: true });

await ctx.addInitScript(() => {
  window.__sraQuery = (sel) => {
    for (const h of document.querySelectorAll('[data-alcoia-host]')) {
      const f = h.shadowRoot?.querySelector(sel); if (f) return f;
    }
    return null;
  };
});

// ── T5 follow-up: same recipe, network capture, longer wait ────────────────
{
  const p = await ctx.newPage();
  const netLog = [];
  p.on('request', (req) => { if (req.url().includes('server.alcoia.app')) netLog.push({ dir: 'req', url: req.url(), method: req.method(), body: req.postData()?.slice(0, 300) }); });
  p.on('response', async (resp) => {
    if (resp.url().includes('server.alcoia.app')) {
      let body = null;
      try { body = (await resp.text()).slice(0, 500); } catch (e) {}
      netLog.push({ dir: 'resp', url: resp.url(), status: resp.status(), body });
    }
  });
  const logs = [];
  p.on('console', (m) => logs.push(m.text()));

  await p.goto('https://en.wikipedia.org/wiki/Attention', { waitUntil: 'load' });
  await p.waitForTimeout(1000);
  for (const y of [400, 900, 1400, 1900, 2400]) {
    await p.mouse.wheel(0, y - (await p.evaluate(() => window.scrollY)));
    await p.waitForTimeout(1200);
  }
  await p.mouse.wheel(0, -700);
  await p.waitForTimeout(500);
  await p.mouse.wheel(0, -400);
  await p.waitForTimeout(8000); // longer wait this time

  const card = await p.evaluate(() => ({
    optionCount: window.__sraQuery ? 0 : 0,
    popup: !!window.__sraQuery('.sra-popup'),
    text: window.__sraQuery('.sra-popup-body')?.textContent || null,
  }));
  console.log('=== T5 follow-up ===');
  console.log('card:', JSON.stringify(card, null, 2));
  console.log('network:', JSON.stringify(netLog, null, 2));
  console.log('relevant logs:', JSON.stringify(logs.filter((l) => /State:|Fetch|error|Error/i.test(l)), null, 2));
  await p.close();
}

// ── T13 follow-up: select an UNAMBIGUOUS, hand-checked plain sentence ──────
{
  const p = await ctx.newPage();
  await p.goto('https://en.wikipedia.org/wiki/Pythagorean_theorem', { waitUntil: 'load' });
  await p.waitForTimeout(1000);
  const selectedText = await p.evaluate(() => {
    const ps = [...document.querySelectorAll('p')].filter((el) => (el.textContent || '').trim().length > 80);
    // Pick a paragraph and select ONLY its plain text via a Range across
    // the whole element (not just firstChild, which can land on a short
    // inline fragment like a citation marker or linked term).
    const target = ps[2] || ps[0];
    const range = document.createRange();
    range.selectNodeContents(target);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    target.dispatchEvent(new Event('mouseup', { bubbles: true }));
    return sel.toString();
  });
  await p.waitForTimeout(500);
  const tooltipShown = await p.evaluate(() => !!window.__sraQuery('#sra-select-tooltip'));
  console.log('=== T13 follow-up ===');
  console.log('selectedText:', JSON.stringify(selectedText));
  console.log('tooltipShown:', tooltipShown);
  await p.close();
}

await ctx.close();
