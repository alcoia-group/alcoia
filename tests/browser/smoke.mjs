/* Loads the TL;DR extension unpacked in Chromium and runs the the project notes
 * verification checklist against a plain article page.
 *
 *   CAM=off node tests/browser/smoke.mjs   (default — camera must stay untouched)
 *   CAM=on  node tests/browser/smoke.mjs   (tracker should start)
 *
 * Checks: content script injects, no page errors, no getUserMedia unless the
 * reader enabled the camera, no image/video data in any request, and that
 * telemetry-only detection still reaches the reader.
 *
 * Not part of `npm test` — it needs a real browser and takes ~20s.
 * Note: WebGazer's face detector is fetched from tfhub.dev, so the gaze path
 * cannot be exercised on a network that blocks it. */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const EXT   = '/home/user/TL-DR/TL_DR';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const HERE  = path.dirname(new URL(import.meta.url).pathname);

// Serve the article over http — file:// needs a separate extension permission
// toggle that would not reflect how the extension actually runs.
const html = fs.readFileSync(path.join(HERE, 'article.html'), 'utf8');
/* Also stands in for the backend, so the question path is exercised for real
 * rather than only its fallback. The question cites a sentence that is
 * genuinely in article.html — the server rejects spans that are not. */
const CANNED_QUESTION = {
  q: 'How is the relationship between eye position and attention described?',
  options: ['Real but weak', 'Strong and direct', 'Entirely absent', 'Exact to the word'],
  // WRONG=1 shifts the correct answer so the harness's click is wrong,
  // exercising the explanation fallback.
  answerIndex: process.env.WRONG === '1' ? 1 : 0,
  explanation: 'The passage calls it real but weak.',
  span: 'The relationship between where the eyes point and what the mind does is real but weak, and it becomes weaker as the measurement apparatus becomes cheaper and noisier than the laboratory equipment on which the original findings were established.',
};

const apiHits = { questions: 0, summarize: 0 };

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/api/')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const isQuestions = req.url.includes('/api/questions');
      if (isQuestions) apiHits.questions++; else apiHits.summarize++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(isQuestions
        ? { questions: [CANNED_QUESTION], cached: false }
        : { summary: 'A canned explanation for the smoke test.' }));
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}).listen(8731);

const findings = { consoleErrors: [], pageErrors: [], getUserMedia: [], mediaRequests: [], engineLogs: [], allLogs: [] };

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tldr-profile-'));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME,
  headless: true,
  channel: 'chromium',            // new headless — supports MV3 extensions
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-sandbox',
  ],
});

// Extension id from the MV3 service worker.
let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;
console.log('extension id:', extId);

// Settings: camera OFF, comprehension ON, debug ON so the engine narrates.
const cfg = await ctx.newPage();
await cfg.goto(`chrome-extension://${extId}/src/popup/popup.html`);
const CAM_ON = process.env.CAM === 'on';
await cfg.evaluate((camOn) => new Promise((r) => chrome.storage.local.set({
  sra_eye: camOn, sra_comprehension: true, sra_debug: true, sra_idle_blink: false,
  sra_backend_url: 'http://localhost:8731/api/summarize',
}, r)), CAM_ON);
const stored = await cfg.evaluate(() => new Promise((r) => chrome.storage.local.get(null, r)));
console.log('camera setting (sra_eye):', stored.sra_eye);
await cfg.close();

const page = await ctx.newPage();

// Trip-wire on getUserMedia before anything on the page runs.
await page.addInitScript(() => {
  window.__gumCalls = [];
  const md = navigator.mediaDevices;
  if (md && md.getUserMedia) {
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = (...a) => { window.__gumCalls.push(JSON.stringify(a[0] || {})); return orig(...a); };
  }
  navigator.getUserMedia = () => { window.__gumCalls.push('legacy'); };
});

page.on('console', (m) => {
  const t = `[${m.type()}] ${m.text()}`;
  findings.allLogs.push(t);
  if (m.type() === 'error') findings.consoleErrors.push(m.text());
  if (/\bState:|SRA|TL;DR/i.test(m.text())) findings.engineLogs.push(m.text());
});
page.on('pageerror', (e) => findings.pageErrors.push(String(e)));
findings.failedRequests = [];
page.on('requestfailed', (r) => findings.failedRequests.push(`${r.url()} :: ${r.failure()?.errorText}`));

// Watch every request for image/video payloads leaving the machine.
page.on('request', (req) => {
  const post = req.postData() || '';
  const looksLikeMedia =
    /data:image|data:video|base64,[A-Za-z0-9+/]{300,}/.test(post) ||
    /"(image|frame|video|snapshot|webcam)"\s*:/i.test(post);
  if (looksLikeMedia) findings.mediaRequests.push({ url: req.url(), sample: post.slice(0, 200) });
  if (req.resourceType() === 'image' && /^https?:/.test(req.url()) && !req.url().includes('localhost:8731')) {
    findings.mediaRequests.push({ url: req.url(), sample: '(outbound image request)' });
  }
});

await page.goto('http://localhost:8731/', { waitUntil: 'load' });
await page.waitForTimeout(3000);

const injected = await page.evaluate(() => ({
  contentScript: !!window.__sra_main || !!document.querySelector('[data-sra-css]'),
  cssLink: !!document.querySelector('[data-sra-css]'),
}));
console.log('content script present:', injected);

// Simulate reading: dwell on paragraphs, then scroll back to re-read.
for (const y of [400, 900, 1400, 1900]) {
  await page.mouse.wheel(0, y - (await page.evaluate(() => window.scrollY)));
  await page.waitForTimeout(1200);
}
await page.waitForTimeout(1000);
// Backtrack: needs delta < -80 and >150px below the recent max, inside 4s.
await page.mouse.wheel(0, -600);
await page.waitForTimeout(500);
await page.mouse.wheel(0, -400);
await page.waitForTimeout(3000);

const gum = await page.evaluate(() => window.__gumCalls || []);
findings.getUserMedia = gum;

const popups = await page.evaluate(() => document.querySelectorAll('.sra-popup').length);

// Answer the question if one was asked, and confirm the card grades it.
const questionCard = await page.evaluate(() => {
  const opts = document.querySelectorAll('.sra-q-option');
  if (!opts.length) return { shown: false };
  const qText = document.querySelector('.sra-q-text')?.textContent || '';
  opts[0].click();
  return { shown: true, question: qText, optionCount: opts.length };
});
if (questionCard.shown) await page.waitForTimeout(1200);
const graded = questionCard.shown
  ? await page.evaluate(() => ({
      marked: !!document.querySelector('.sra-q-correct'),
      result: document.querySelector('.sra-q-result')?.textContent?.trim().slice(0, 60) || null,
      disabled: [...document.querySelectorAll('.sra-q-option')].every((b) => b.disabled),
    }))
  : null;

// Session recall: reader-initiated review of what was actually read.
const beforeRecall = apiHits.questions;
await page.keyboard.down('Alt'); await page.keyboard.press('KeyR'); await page.keyboard.up('Alt');
await page.waitForTimeout(2500);
const recall = {
  questionsFetched: apiHits.questions - beforeRecall,
  cardOnScreen: await page.evaluate(() => !!document.querySelector('.sra-q-options')),
};

// Receipt: reader-triggered (Alt+I), previewed in full before anything leaves.
await page.keyboard.down('Alt'); await page.keyboard.press('KeyI'); await page.keyboard.up('Alt');
await page.waitForTimeout(900);
const receipt = await page.evaluate(() => {
  const panel = document.querySelector('.sra-receipt');
  if (!panel) return { shown: false };
  const raw = panel.querySelector('.sra-r-raw pre')?.textContent || '';
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) {}
  return {
    shown: true,
    showsFullContents: raw.length > 0,
    hasUrl: /https?:\/\//.test(raw),
    hasGazeKey: /"(gaze|coords|points|samples)"/.test(raw),
    recallAnswered: parsed?.recall?.answered ?? null,
    coveragePct: parsed?.session?.coveragePct ?? null,
    caveatShown: !!panel.querySelector('.sra-r-caveat'),
  };
});

console.log('\n================ RESULTS ================');
console.log('content script injected :', injected.contentScript);
console.log('page errors             :', findings.pageErrors.length, findings.pageErrors.slice(0, 5));
console.log('console errors          :', findings.consoleErrors.length, findings.consoleErrors.slice(0, 8));
console.log('getUserMedia calls      :', findings.getUserMedia.length, findings.getUserMedia);
console.log('image/video in requests :', findings.mediaRequests.length, findings.mediaRequests.slice(0, 3));
console.log('popups rendered         :', popups);
console.log('api hits                :', JSON.stringify(apiHits));
console.log('question card           :', JSON.stringify(questionCard));
console.log('after answering         :', JSON.stringify(graded));
console.log('session recall (Alt+R)  :', JSON.stringify(recall));
console.log('receipt (Alt+I)         :', JSON.stringify(receipt));
console.log('failed requests         :', findings.failedRequests.length, findings.failedRequests.slice(0,5));
console.log('engine/SRA logs         :', findings.engineLogs.length);
findings.engineLogs.slice(0, 25).forEach((l) => console.log('   ', l));
console.log('--- all console output (first 40) ---');
findings.allLogs.slice(0, 40).forEach((l) => console.log('   ', l));
console.log('=========================================');

await ctx.close();
server.close();
