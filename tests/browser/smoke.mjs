/* Loads the alcoia extension unpacked in Chromium and runs the the project notes
 * verification checklist against a plain article page.
 *
 *   node tests/browser/smoke.mjs
 *
 * Checks: content script injects, no page errors, no getUserMedia call ever
 * (there is no camera path left to make one — see the project notes' migration
 * note on removing webcam gaze), no image/video data in any request, and
 * that reading-signal-only detection reaches the reader.
 *
 * Not part of `npm test` — it needs a real browser and takes ~20s. */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

/* Paths are derived, not pinned. They used to be absolute Linux paths, so the
 * check could only run on one machine — and a verification step nobody can
 * run is a verification step that stops being run. CHROME falls back to
 * whichever Chromium Playwright installed (`npx playwright install chromium`). */
const HERE  = path.dirname(fileURLToPath(import.meta.url));
const EXT   = process.env.EXT || path.resolve(HERE, '..', '..', 'alcoia');
const PINNED_CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CHROME = process.env.CHROME
  || (fs.existsSync(PINNED_CHROME) ? PINNED_CHROME : chromium.executablePath());

// Serve the article over http — file:// needs a separate extension permission
// toggle that would not reflect how the extension actually runs.
/* PAGE=zh runs the same checklist against a Chinese article. That page is not
 * decoration: every word count in the pipeline used to be a whitespace split,
 * which returns 1 for an entire CJK paragraph, so the extension produced no
 * signal at all on those pages — silently, with every test passing. This is
 * the guard against that returning. */
const ZH = process.env.PAGE === 'zh';
const html = fs.readFileSync(path.join(HERE, ZH ? 'article-zh.html' : 'article.html'), 'utf8');
/* Also stands in for the backend, so the question path is exercised for real
 * rather than only its fallback. The question cites a sentence that is
 * genuinely in article.html — the server rejects spans that are not. */
const CANNED_QUESTION = ZH ? {
  q: '眼睛所指向的位置与心智活动之间的关系被描述为怎样？',
  options: ['真实但微弱', '强而直接', '完全不存在', '精确到每一个词'],
  answerIndex: process.env.WRONG === '1' ? 1 : 0,
  explanation: '文中称这种关系真实存在但相当微弱。',
  span: '眼睛所指向的位置与心智所进行的活动之间的关系是真实存在的，但相当微弱，而且当测量设备比当初得出这些结论时所使用的实验室仪器更加廉价、更加嘈杂时，这种关系就会变得更加微弱。',
} : {
  q: 'How is the relationship between eye position and attention described?',
  options: ['Real but weak', 'Strong and direct', 'Entirely absent', 'Exact to the word'],
  // WRONG=1 shifts the correct answer so the harness's click is wrong,
  // exercising the explanation fallback.
  answerIndex: process.env.WRONG === '1' ? 1 : 0,
  explanation: 'The passage calls it real but weak.',
  span: 'The relationship between where the eyes point and what the mind does is real but weak, and it becomes weaker as the measurement apparatus becomes cheaper and noisier than the laboratory equipment on which the original findings were established.',
};

const apiHits = { questions: 0, summarize: 0, token: 0 };
const TOKEN_HEADER = 'x-alcoia-install-token';
const SMOKE_TOKEN = 'smoke-test-token';
// Every /api/summarize or /api/questions request seen without the install
// token header attached — item 9's "every AI request carries the token",
// checked the only way it can be from outside content.js/background.js.
const requestsMissingToken = [];

/* FAIL=questions simulates the server rejecting every question — a 422 with
 * no citable span, the same shape a real "nothing passed the citation check"
 * response takes. Item 8 in the build brief made this degrade to silence
 * (no card at all) instead of falling back to a comprehension-offer popup;
 * this mode is what actually exercises that fix end to end, since none of
 * content.js's internals are exported for a unit test to reach directly. */
const FAIL_QUESTIONS = process.env.FAIL === 'questions';
// FAIL=token simulates the install-token endpoint itself being unreachable —
// every AI call should then fail silently for lack of a token, before ever
// reaching the summarize/questions handlers below. Expect this mode to still
// report a handful of `console errors` — Chromium logs the service worker's
// own failed 503 fetches to devtools regardless of how gracefully the code
// then handles them, which is normal browser behaviour, not a page error.
// `page errors` (thrown exceptions) staying at 0 is the assertion that
// actually matters here, and is checked below.
const FAIL_TOKEN = process.env.FAIL === 'token';
// Item 36: see the /api/summarize handler below for what this controls.
let nextSummarizeBehavior = null;

// Item 29: a minimal hand-built one-page PDF for the viewer escape-hatch
// check — no external PDF-generation dependency, and small enough to keep
// inline. Real syntax (a Type1 Helvetica font, one content stream, a proper
// xref table), not a stub — pdf.js parses it exactly like a real document.
function minimalPdfBytes() {
  const esc = (s) => s.replace(/([\\()])/g, '\\$1');
  const text = 'ITEM29-PDF-MARKER: a real one-page PDF for the escape-hatch check.';
  const stream = `BT /F1 14 Tf 1 0 0 1 72 700 Tm (${esc(text)}) Tj ET`;
  const objects = [
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Page /Parent 4 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 1 0 R >> >> /Contents 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Catalog /Pages 4 0 R >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets.slice(1)) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 5 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}
const TEST_PDF_BYTES = minimalPdfBytes();

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/item29-test.pdf')) {
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    res.end(TEST_PDF_BYTES);
    return;
  }
  // Item 31: a real, reachable PDF for the web-takeover redirect check —
  // distinct from item29-test.pdf only so the two items' checks cannot be
  // confused for one another in a failure report.
  if (req.url.startsWith('/item31-test.pdf')) {
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    res.end(TEST_PDF_BYTES);
    return;
  }
  // A PDF-looking URL whose response is not a real PDF at all — proves the
  // fail-open path (viewer.js bounces back to native handling rather than
  // showing an alcoia error page) without needing an actual auth wall.
  if (req.url.startsWith('/item31-broken.pdf')) {
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    res.end('not actually a pdf');
    return;
  }
  // A normal page embedding item31-test.pdf in an iframe — proves
  // tabs.onUpdated (tab-level only) never redirects an iframe's own
  // navigation, since the TAB's own URL never changes when only the frame
  // inside it loads a PDF.
  if (req.url.startsWith('/item31-iframe.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><iframe src="/item31-test.pdf" width="600" height="400"></iframe></body></html>');
    return;
  }
  if (req.method === 'POST' && req.url.startsWith('/api/token')) {
    apiHits.token++;
    if (FAIL_TOKEN) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: SMOKE_TOKEN }));
    return;
  }
  if (req.method === 'POST' && req.url.startsWith('/api/')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const isQuestions = req.url.includes('/api/questions');
      if (isQuestions) apiHits.questions++; else apiHits.summarize++;
      if (req.headers[TOKEN_HEADER] !== SMOKE_TOKEN) requestsMissingToken.push(req.url);
      if (isQuestions && FAIL_QUESTIONS) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no_citable_question' }));
        return;
      }
      // Item 36: a one-shot override for the next /api/summarize response
      // only, set directly from the test flow below and self-clearing after
      // one use — 'poison' fails the call (for the "explanation persistence
      // degrades to silence on fetch failure" check), a string overrides the
      // canned summary text (for the "the stored explanation is capped
      // shorter than what the popup shows" check). Deliberately not a whole-
      // process FAIL= mode like FAIL_QUESTIONS/FAIL_TOKEN: this only needs
      // to affect one specific call inside an otherwise-normal run, not the
      // whole suite.
      if (!isQuestions && nextSummarizeBehavior !== null) {
        const behavior = nextSummarizeBehavior;
        nextSummarizeBehavior = null;
        if (behavior === 'poison') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'poisoned_for_test' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ summary: behavior }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // A quiz (item 17) asks for count >= 5 in one call — the mock returns
      // that many so the happy path can be exercised for real, rather than
      // always answering with the single CANNED_QUESTION every other
      // (count: 1) caller in this file expects.
      let requestedCount = 1;
      try { requestedCount = Number(JSON.parse(body || '{}').count) || 1; } catch (e) {}
      const questions = requestedCount >= 5
        ? Array.from({ length: requestedCount }, (_, i) => ({ ...CANNED_QUESTION, q: `${CANNED_QUESTION.q} (${i + 1})` }))
        : [CANNED_QUESTION];
      res.end(JSON.stringify(isQuestions
        ? { questions, cached: false }
        : { summary: 'A canned explanation for the smoke test.' }));
    });
    return;
  }
  // Item 25: colour-highlight persistence fixture. Same pathname regardless
  // of query string — content.js's urlKey (hostname+pathname) ignores the
  // query — so ?insert=1 serving extra prepended content simulates the same
  // document having changed between visits, without changing its storage
  // key, which is exactly the "anchoring survives text shifting" case.
  if (req.url.startsWith('/hl-fixture.html')) {
    const insert = req.url.includes('insert=1');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body>
      ${insert ? '<p>A new paragraph the page did not have on the first visit, pushing everything below it further down.</p>'.repeat(3) : ''}
      <p id="hl-target">The relationship between where the eyes point and what the mind does is real but weak, and it becomes weaker as the measurement apparatus becomes cheaper and noisier than the laboratory equipment on which the original findings were established.</p>
      <p>A second, unrelated paragraph so the page has more than one block of text.</p>
    </body></html>`);
    return;
  }
  // Item 27: a minimal but genuine SPA fixture — real client-side routing via
  // history.pushState() called from the PAGE's own main-world script (not
  // from anything the extension injects), swapping #app's content and the
  // URL's pathname with no network request at all. Both "routes" below are
  // client-side only; the server only ever serves the initial GET.
  if (req.url.startsWith('/spa-fixture')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body>
      <div style="height:1400px"></div>
      <div id="app">
        <p class="spa-par">Article one opens with a long enough paragraph to be tracked by the paragraph tracker, which needs at least twenty words before it counts as prose worth measuring at all here.</p>
        <p class="spa-par">Article one continues with a second paragraph, also long enough on its own to clear the same twenty word floor the tracker enforces before treating anything as real reading material.</p>
      </div>
      <button id="spa-nav-btn">Go to article two</button>
      <button id="spa-back-btn" style="display:none">Back to article one</button>
      <div style="height:1400px"></div>
      <script>
        var ARTICLE_ONE = document.getElementById('app').innerHTML;
        var ARTICLE_TWO =
          '<p class="spa-par">Article two opens with an entirely different long paragraph, unrelated to article one, still comfortably over the twenty word floor the paragraph tracker requires before counting it.</p>' +
          '<p class="spa-par">Article two continues with a second paragraph of its own, again well past the word floor, so the tracker has real prose to measure on the freshly swapped in route content.</p>';
        document.getElementById('spa-nav-btn').addEventListener('click', function () {
          document.getElementById('app').innerHTML = ARTICLE_TWO;
          document.getElementById('spa-nav-btn').style.display = 'none';
          document.getElementById('spa-back-btn').style.display = '';
          history.pushState({}, '', '/spa-fixture/article-two');
        });
        document.getElementById('spa-back-btn').addEventListener('click', function () {
          document.getElementById('app').innerHTML = ARTICLE_ONE;
          document.getElementById('spa-back-btn').style.display = 'none';
          document.getElementById('spa-nav-btn').style.display = '';
          history.pushState({}, '', '/spa-fixture.html');
        });
      </script>
    </body></html>`);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}).listen(8731);

const findings = { consoleErrors: [], pageErrors: [], getUserMedia: [], mediaRequests: [], engineLogs: [], allLogs: [], thirdParty: [] };

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

// Settings: comprehension ON, debug ON so the engine narrates.
const cfg = await ctx.newPage();
await cfg.goto(`chrome-extension://${extId}/src/popup/popup.html`);
await cfg.evaluate(() => new Promise((r) => chrome.storage.local.set({
  sra_comprehension: true, sra_debug: true,
  sra_backend_url: 'http://localhost:8731/api/summarize',
}, r)));
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
  if (/\bState:|SRA|alcoia/i.test(m.text())) findings.engineLogs.push(m.text());
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
  /* Anything leaving for a host that is not the page and not the backend. The
     overlay stylesheet used to pull a font from fonts.googleapis.com on every
     page the reader opened, which handed Google their IP and the referrer. */
  const u = req.url();
  if (/^https?:/.test(u) && !u.includes('localhost:8731')) findings.thirdParty.push(u);
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

/* Computed styles, not just element presence. The question card and the
 * receipt once shipped their CSS in a file nothing loaded, and every test
 * here passed while they rendered as unstyled default HTML — clicking
 * `.sra-q-option` works perfectly on a bare <button>. Assert that a rule
 * reaches the element and that the bundled family is the one resolving. */
const styling = await page.evaluate(() => {
  const card = document.querySelector('.sra-popup');
  const opt  = document.querySelector('.sra-q-option');
  const cs   = card && getComputedStyle(card);
  const os   = opt && getComputedStyle(opt);
  return {
    cardStyled:   !!cs && cs.position === 'fixed' && parseFloat(cs.borderTopLeftRadius) > 0,
    cardFamily:   cs ? cs.fontFamily.split(',')[0].replace(/["']/g, '') : null,
    optionStyled: !!os && parseFloat(os.borderTopLeftRadius) > 0,
    fontsLoaded:  [...new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family))],
  };
});

// Answer the question if one was asked. Picking an option only selects it
// (item 13: commit-time confidence) — grading happens once the confidence
// step is resolved, exercised here with a real rating rather than skipping
// it, so the full commit path runs in an actual browser at least once.
const questionCard = await page.evaluate(() => {
  const opts = document.querySelectorAll('.sra-q-option');
  if (!opts.length) return { shown: false };
  const qText = document.querySelector('.sra-q-text')?.textContent || '';
  opts[0].click();
  const confidenceShown = !!document.querySelector('.sra-q-confidence');
  const gradedBeforeConfidence = !!document.querySelector('.sra-q-result');
  return { shown: true, question: qText, optionCount: opts.length, confidenceShown, gradedBeforeConfidence };
});
if (questionCard.shown) {
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('.sra-q-conf-btn[data-conf="high"]')?.click());
  await page.waitForTimeout(1200);
}
const graded = questionCard.shown
  ? await page.evaluate(() => ({
      marked: !!document.querySelector('.sra-q-correct'),
      result: document.querySelector('.sra-q-result')?.textContent?.trim().slice(0, 60) || null,
      resultIsCorrectStyled: !!document.querySelector('.sra-q-result-correct'),
      disabled: [...document.querySelectorAll('.sra-q-option')].every((b) => b.disabled),
      confidenceStepGone: !document.querySelector('.sra-q-confidence'),
      // Item 19: only meaningful under WRONG=1 — the harness always clicks
      // options[0], which is only wrong when that env var shifts the
      // answer, so a normal run legitimately has hasHighlight: false here
      // (no explanation shown at all on a correct answer).
      hasHighlight: !!document.querySelector('.sra-q-result .sra-term'),
      noHighlightInQuestionOrOptions: !document.querySelector('.sra-q-text .sra-term')
        && ![...document.querySelectorAll('.sra-q-option')].some((o) => o.querySelector('.sra-term')),
      noHighlightInQuotedSpan: !document.querySelector('.sra-q-span .sra-term'),
    }))
  : null;

/* Item 12: a correct answer is confirmation only — never
 * question.explanation, never the quoted span. Gate on resultIsCorrectStyled
 * (the .sra-q-result-correct class, applied only on the branch the reader's
 * own click actually took), not on `marked` — `.sra-q-correct` marks
 * whichever option IS the right one regardless of which the reader clicked,
 * so it is true after every answer and would gate this on the wrong thing. */
const correctAnswerSilence = graded && graded.resultIsCorrectStyled ? {
  noExplanationLeaked: !graded.result || !graded.result.includes(CANNED_QUESTION.explanation.slice(0, 15)),
  noSpanRendered: !(await page.evaluate(() => !!document.querySelector('.sra-q-span'))),
} : null;

// Session recall: reader-initiated review of what was actually read.
const beforeRecall = apiHits.questions;
await page.keyboard.down('Alt'); await page.keyboard.press('KeyR'); await page.keyboard.up('Alt');
await page.waitForTimeout(2500);
const recall = {
  questionsFetched: apiHits.questions - beforeRecall,
  cardOnScreen: await page.evaluate(() => !!document.querySelector('.sra-q-options')),
};

/* Every keyboard shortcut, pressed. The P6 refactor silently deleted the whole
 * handler and 133 unit tests plus this smoke check all passed, because none of
 * them pressed a key. They do now. */
const shortcuts = { errorsBefore: findings.pageErrors.length, results: {} };
async function alt(key) {
  await page.keyboard.down('Alt');
  await page.keyboard.press(key);
  await page.keyboard.up('Alt');
  await page.waitForTimeout(350);
}

await alt('Digit1');   // simulate struggling
shortcuts.results.altDigit1_toast = await page.evaluate(() => !!document.getElementById('sra-sim-toast'));
await alt('KeyT');     // toggle TTS
shortcuts.results.altT_toast = await page.evaluate(() => !!document.getElementById('sra-sim-toast'));
await alt('KeyF');     // toggle focus ruler
shortcuts.results.altF_ruler = await page.evaluate(() =>
  !!document.querySelector('[class*="ruler"],[id*="ruler"]') || !!document.getElementById('sra-sim-toast'));
await alt('KeyM');     // toggle reading map
shortcuts.results.altM_map = await page.evaluate(() => !!document.getElementById('sra-reading-map'));
await alt('KeyS');     // summarise paragraph at viewport centre
await page.waitForTimeout(500);
shortcuts.results.altS_popup = await page.evaluate(() => document.querySelectorAll('.sra-popup').length > 0);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
shortcuts.results.escape_closedUnpinned = await page.evaluate(() =>
  [...document.querySelectorAll('.sra-popup')].every((el) => el.dataset.pinned === 'true'));
shortcuts.newPageErrors = findings.pageErrors.length - shortcuts.errorsBefore;

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

// Item 15: the coverage gate accumulates from the same reading simulated
// above, persisted (not in-memory) and keyed by hostname+pathname — not
// window.location.href — so it survives a query string. Verified here by
// reloading the exact same page with an added ?utm_source= and confirming
// the accumulated coverage carried over rather than resetting.
//
// chrome.storage.local is only reachable from a content script or an
// extension page, not from the article page's own JS context (`page`,
// above) — so this reads it through a throwaway extension page, the same
// way the settings are seeded via `cfg` near the top of this file.
async function readCoverage(pageKey) {
  const helper = await ctx.newPage();
  await helper.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  const result = await helper.evaluate((key) => new Promise((r) => {
    chrome.storage.local.get({ sra_doc_coverage: {} }, (data) => {
      const doc = (data.sra_doc_coverage || {})[key];
      r(doc
        ? { tracked: true, paragraphsCovered: doc.fingerprints.length, totalParagraphs: doc.totalParagraphs, dwellMs: doc.dwellMs }
        : { tracked: false, paragraphsCovered: 0, totalParagraphs: 0, dwellMs: 0 });
    });
  }), pageKey);
  await helper.close();
  return result;
}

const pageKey = new URL(page.url()).hostname + new URL(page.url()).pathname;
const coverage = { key: pageKey, ...(await readCoverage(pageKey)) };

await page.goto('http://localhost:8731/?utm_source=smoke-test', { waitUntil: 'load' });
await page.waitForTimeout(1500);
const coverageAfterQueryString = await readCoverage(pageKey); // pathname-only key — the query string above is not part of it

// item 16: content.js's checkQuizCoverage message handler is what both the
// popup button and (indirectly, via coverage-gate.js) the end-of-reading
// offer rely on — checked directly here via chrome.tabs.sendMessage from a
// helper extension page, the same call popup.js's sendToTab() makes, since
// Playwright cannot easily drive the real toolbar-popup UI to exercise
// popup.js itself.
// urlPattern defaults to matching every localhost:8731 tab, which is fine
// when only one exists (the quiz check above). The snooze check below opens
// a second article tab at the same origin with a different query string, so
// it passes an exact pattern to disambiguate — a Chrome match pattern with
// no trailing `*` matches only that literal URL, not one with a query
// string appended.
async function sendToArticleTab(msg, urlPattern = 'http://localhost:8731/*') {
  const helper = await ctx.newPage();
  await helper.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  const result = await helper.evaluate(({ m, pattern }) => new Promise((resolve) => {
    chrome.tabs.query({ url: pattern }, (tabs) => {
      if (!tabs?.[0]) { resolve({ __debug: 'no tabs', all: 'n/a' }); return; }
      chrome.tabs.sendMessage(tabs[0].id, m, (resp) => {
        if (chrome.runtime.lastError) { resolve({ __debug: chrome.runtime.lastError.message }); return; }
        resolve(resp);
      });
    });
  }), { m: msg, pattern: urlPattern });
  await helper.close();
  return result;
}

// Pins the message-listener fix above: popup.js's recallBtn/receiptBtn send
// exactly these `{ action: ... }` shapes via sendToTab, and previously got
// no response at all (the listener discarded any message without `.type`).
const recallStatsCheck = await sendToArticleTab({ action: 'recallStats' });
const quizCoverageCheck = await sendToArticleTab({ action: 'checkQuizCoverage' });
// The reading simulated above is ~9s of dwell — realistic, and well under
// the 60s minimum by design (see coverage-gate.js's DEFAULT_THRESHOLDS), so
// this should consistently read not-ready with the exact required reason.
const quizGateBelowThreshold = quizCoverageCheck ? {
  ready: quizCoverageCheck.ready,
  reason: quizCoverageCheck.reason,
  correctReason: quizCoverageCheck.reason === 'not enough reading tracked on this page yet',
} : null;

// Now push the same document's *measured* dwell time over the threshold —
// same paragraphs, same coverage percentage, modelling a reader who spent
// longer on them — and confirm the unprompted offer actually renders, is
// dismissible, and never reappears for this document once dismissed. This
// is the one place the full offer -> render -> dismiss -> stays-dismissed
// path is exercised in a real page rather than only against fake storage.
const helperWrite = await ctx.newPage();
await helperWrite.goto(`chrome-extension://${extId}/src/popup/popup.html`);
await helperWrite.evaluate((key) => new Promise((r) => {
  chrome.storage.local.get({ sra_doc_coverage: {} }, (data) => {
    const docs = data.sra_doc_coverage || {};
    if (docs[key]) docs[key].dwellMs = 70000;
    chrome.storage.local.set({ sra_doc_coverage: docs }, r);
  });
}), pageKey);
await helperWrite.close();

// The page reload above (for the ?query-string check) reset scrollY to 0,
// so this needs to actually reach the bottom again, not just nudge — a
// short article's bottom can be well past what the earlier reading
// simulation scrolled to.
await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
await page.waitForTimeout(800);
const offerShown = await page.evaluate(() => {
  const card = [...document.querySelectorAll('.sra-popup')]
    .find((el) => el.querySelector('.sra-quiz-start-btn'));
  return card ? { shown: true, text: card.querySelector('.sra-q-text')?.textContent || null } : { shown: false };
});
if (offerShown.shown) {
  await page.evaluate(() => document.querySelector('.sra-q-skip')?.click());
  await page.waitForTimeout(400); // closePopup() fades out over 250ms before removing the element
}
const offerGoneAfterDismiss = await page.evaluate(() =>
  !document.querySelector('.sra-quiz-start-btn'));
await page.mouse.wheel(0, -30); // scroll again — must not reappear (once per document)
await page.waitForTimeout(500);
const offerStaysDismissed = await page.evaluate(() =>
  !document.querySelector('.sra-quiz-start-btn'));

// Item 17: the quiz page. session-recall.js needs at least one paragraph to
// individually clear its own MIN_DWELL_MS (4s) before select() returns
// anything — the reading simulated earlier spreads ~1.2s per paragraph, so a
// dedicated dwell is needed here rather than assuming the earlier scroll
// already produced a candidate.
let quizResult = { attempted: false };
if (!FAIL_QUESTIONS && !FAIL_TOKEN) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.mouse.wheel(0, 260); // settle on one paragraph
  await page.waitForTimeout(4500); // clears session-recall's MIN_DWELL_MS
  await page.mouse.wheel(0, 260); // leave it — this is what records the dwell

  // sendToArticleTab() below opens its own short-lived helper page to send
  // the message, which ALSO fires the context's 'page' event — collecting
  // every new page and filtering by URL avoids grabbing that helper instead
  // of the real quiz tab background.js opens once runQuiz() finishes.
  const newPages = [];
  const onNewPage = (p) => newPages.push(p);
  ctx.on('page', onNewPage);
  const startQuiz = await sendToArticleTab({ action: 'startQuiz' });
  let quizPage = null;
  if (startQuiz?.started) {
    for (let i = 0; i < 20 && !quizPage; i++) {
      await page.waitForTimeout(200);
      quizPage = newPages.find((p) => p.url().includes('quiz.html')) || null;
    }
  }
  ctx.off('page', onNewPage);

  if (quizPage) {
    const quizPageErrors = [];
    quizPage.on('pageerror', (e) => quizPageErrors.push(String(e)));
    await quizPage.waitForLoadState('load');
    await quizPage.waitForTimeout(500);
    const answers = [];
    for (let i = 0; i < 10; i++) { // bounded loop — a real quiz is 5-8 questions
      const state = await quizPage.evaluate(() => ({
        hasQuestion: !!document.querySelector('.sra-q-option'),
        hasResults: !!document.getElementById('deleteThisBtn'),
      }));
      if (state.hasResults) break;
      if (!state.hasQuestion) break;
      await quizPage.evaluate(() => document.querySelector('.sra-q-option[data-index="0"]').click());
      await quizPage.evaluate(() => document.querySelector('.sra-q-conf-skip')?.click());
      await quizPage.waitForTimeout(150);
      const graded = await quizPage.evaluate(() => !!document.querySelector('.sra-q-result'));
      answers.push(graded);
      await quizPage.evaluate(() => {
        const next = [...document.querySelectorAll('button')].find((b) => /Next question|See results/.test(b.textContent));
        next?.click();
      });
      await quizPage.waitForTimeout(200);
    }
    const resultsShown = await quizPage.evaluate(() => ({
      tally: document.querySelector('.results-tally')?.textContent || null,
      rowCount: document.querySelectorAll('.result-row').length,
    }));

    // Deletion must actually delete (the project notes) — confirmed by reopening the
    // same document's quiz URL and checking nothing resumes.
    await quizPage.evaluate(() => document.getElementById('deleteThisBtn')?.click());
    await quizPage.waitForTimeout(200);
    const emptyAfterDelete = await quizPage.evaluate(() => document.querySelector('.empty-state')?.textContent || null);
    await quizPage.reload();
    await quizPage.waitForTimeout(500);
    const emptyAfterReload = await quizPage.evaluate(() => document.querySelector('.empty-state')?.textContent || null);

    quizResult = {
      attempted: true,
      started: true,
      questionsAnswered: answers.length,
      allGraded: answers.length > 0 && answers.every(Boolean),
      resultsShown,
      emptyAfterDelete,
      deletionPersisted: !!emptyAfterReload,
      newErrorsDuringQuiz: quizPageErrors.length,
    };
    await quizPage.close();
  } else {
    quizResult = { attempted: true, started: false, note: 'runQuiz() declined — see reason below' };
  }
}

// Item 18: snooze. A fresh page/session so the 3-minute interruption gap
// from the main flow above doesn't interfere with getting a real card to
// snooze from. Tests the card's own control end to end: a real interruption
// appears, its snooze control dismisses it and starts a real snooze, no
// further interruption appears despite continued reading, and detection
// (coverage accumulation) keeps running the whole time regardless.
let snoozeResult = { attempted: false };
if (!FAIL_QUESTIONS && !FAIL_TOKEN) {
  const snoozePage = await ctx.newPage();
  const snoozePageErrors = [];
  snoozePage.on('pageerror', (e) => snoozePageErrors.push(String(e)));
  await snoozePage.goto('http://localhost:8731/', { waitUntil: 'load' });
  await snoozePage.waitForTimeout(1000);

  async function readSnoozeCoverage() {
    const helper = await ctx.newPage();
    await helper.goto(`chrome-extension://${extId}/src/popup/popup.html`);
    const result = await helper.evaluate(() => new Promise((r) => {
      chrome.storage.local.get({ sra_doc_coverage: {} }, (data) => {
        const doc = (data.sra_doc_coverage || {})['localhost/'];
        r(doc ? { fingerprints: doc.fingerprints.length, dwellMs: doc.dwellMs } : { fingerprints: 0, dwellMs: 0 });
      });
    }));
    await helper.close();
    return result;
  }

  let cardSeen = false;
  for (const y of [400, 900, 1400, 1900, 2400]) {
    await snoozePage.mouse.wheel(0, y - (await snoozePage.evaluate(() => window.scrollY)));
    await snoozePage.waitForTimeout(1200);
    cardSeen = await snoozePage.evaluate(() => !!document.querySelector('.sra-q-snooze-toggle'));
    if (cardSeen) break;
  }

  if (cardSeen) {
    await snoozePage.evaluate(() => document.querySelector('.sra-q-snooze-toggle').click());
    await snoozePage.waitForTimeout(200);
    const durationsOffered = await snoozePage.evaluate(() =>
      document.querySelectorAll('.sra-q-snooze-options button').length);
    await snoozePage.evaluate(() => document.querySelector('.sra-q-snooze-options button[data-snooze="15m"]').click());
    await snoozePage.waitForTimeout(500); // closePopup()'s fade-out

    const cardGoneAfterSnooze = await snoozePage.evaluate(() => !document.querySelector('.sra-q-option'));
    const toastShown = await snoozePage.evaluate(() =>
      !!document.getElementById('sra-status-toast') && document.getElementById('sra-status-toast').textContent);

    const coverageBefore = await readSnoozeCoverage();
    // Keep reading while snoozed — several more struggle-shaped scrolls,
    // enough that without the snooze this would very likely have produced
    // at least one more interruption once the 3-minute gap allowed it.
    for (const y of [3000, 2000, 3400, 2200]) {
      await snoozePage.mouse.wheel(0, y - (await snoozePage.evaluate(() => window.scrollY)));
      await snoozePage.waitForTimeout(900);
    }
    const noNewInterruptionWhileSnoozed = await snoozePage.evaluate(() => !document.querySelector('.sra-q-option'));
    const coverageAfter = await readSnoozeCoverage();

    // sendToArticleTab() (defined earlier) targets whichever tab matches
    // localhost:8731 — with only one such tab open at this point (the main
    // `page` was navigated to ?utm_source=... earlier, no longer matching
    // the bare pattern reliably), this reaches snoozePage.
    const status = await sendToArticleTab({ action: 'getSnoozeStatus' }, 'http://localhost:8731/');
    await sendToArticleTab({ action: 'cancelSnooze' }, 'http://localhost:8731/');
    const statusAfterCancel = await sendToArticleTab({ action: 'getSnoozeStatus' }, 'http://localhost:8731/');

    snoozeResult = {
      attempted: true,
      cardHadSnoozeControl: true,
      durationsOffered,
      cardGoneAfterSnooze,
      toastShown,
      statusWhileActive: status,
      noNewInterruptionWhileSnoozed,
      detectionContinuedWhileSnoozed: coverageAfter.dwellMs >= coverageBefore.dwellMs && coverageAfter.fingerprints >= coverageBefore.fingerprints,
      statusAfterCancel,
      newPageErrors: snoozePageErrors.length,
    };
  } else {
    snoozeResult = { attempted: true, cardHadSnoozeControl: false, note: 'no interruption appeared to snooze from in this run' };
  }
  await snoozePage.close();
}

const failureDegrade = FAIL_QUESTIONS ? {
  questionsEndpointCalled: apiHits.questions > 0,
  noQuestionCardShown: !questionCard.shown,
  noPageErrors: findings.pageErrors.length === 0,
} : null;

const tokenFailureDegrade = FAIL_TOKEN ? {
  tokenEndpointCalled: apiHits.token > 0,
  noAiCallEverMade: apiHits.summarize === 0 && apiHits.questions === 0,
  noQuestionCardShown: !questionCard.shown,
  noPageErrors: findings.pageErrors.length === 0,
} : null;

// Every AI request the mock server actually received should have carried
// the install token — checked regardless of FAIL mode, since the happy
// path is where "every AI request carries the token" is really exercised.
const tokenAttachment = {
  tokenIssued: apiHits.token > 0,
  everyAiRequestCarriedIt: requestsMissingToken.length === 0,
  missing: requestsMissingToken,
};

// Diagnostics page (item 14): opened as its own top-level extension page,
// same as notes.html/session-report.html — not part of the article page at
// all, so this is the one place to check it independently of anything
// above. FAIL modes never reach here (each run picks one server behaviour),
// so the error-log assertions are conditional on what actually happened.
const diagPage = await ctx.newPage();
await diagPage.goto(`chrome-extension://${extId}/src/popup/diagnostics.html`);
await diagPage.waitForTimeout(400);
const diagnostics = await diagPage.evaluate(() => ({
  version: document.getElementById('val-version')?.textContent || null,
  tokenStatus: document.getElementById('val-tokenStatus')?.textContent || null,
  tokenMasked: document.getElementById('val-tokenMasked')?.textContent || null,
  settingsRowCount: document.querySelectorAll('#settingsGrid .kv-row').length,
  errorLogText: document.getElementById('errorLog')?.textContent || '',
}));
// "Safe to screenshot": the raw install token must never appear (only its
// masked form should), and nothing from the article page — its title or
// URL — has any way to reach this page in the first place, since
// diagnostics.js never touches the current tab. Checked directly here
// rather than assumed.
const diagSafety = {
  noRawToken: !diagnostics.tokenMasked?.includes(SMOKE_TOKEN) &&
    !(await diagPage.evaluate((t) => document.body.innerHTML.includes(t), SMOKE_TOKEN)),
  noArticleTitle: !(await diagPage.evaluate(
    (title) => document.body.innerHTML.includes(title), CANNED_QUESTION.q)),
};
await diagPage.evaluate(() => document.getElementById('deleteTokenBtn')?.click());
await diagPage.waitForTimeout(100);
const afterDelete = await diagPage.evaluate(() => document.getElementById('val-tokenStatus')?.textContent || null);

// Item 33: the developer tools moved here from the main popup, gated on
// sra_debug (already on globally in this harness — see the cfg block at the
// top of this file). Confirms the card is genuinely visible under a real
// debug-on setting, not just present-but-hidden in the DOM, and that its
// simulate button reaches the real page through the same message path the
// keyboard shortcut uses — clicking it should produce the same
// #sra-sim-toast the Alt+1 check below looks for.
const devToolsResult = await diagPage.evaluate(() => ({
  devCardVisible: !document.getElementById('devCard')?.hidden,
  backendUrlFieldPresent: !!document.getElementById('devBackendUrl'),
  backendUrlFieldValue: document.getElementById('devBackendUrl')?.value || null,
}));
await diagPage.close();
// chrome.tabs.query({active:true, currentWindow:true}) inside diagnostics.js
// resolves to whichever tab Chrome itself considers active — the article
// page must be that tab for the click below to reach it, so bring it to
// front first. Playwright can still click a background (diagnostics) tab's
// DOM directly via CDP without needing that tab focused.
await page.bringToFront();
const diagPage2 = await ctx.newPage();
await diagPage2.goto(`chrome-extension://${extId}/src/popup/diagnostics.html`);
await diagPage2.waitForTimeout(400);
await page.bringToFront();
await diagPage2.evaluate(() => document.getElementById('simStrugglingBtn')?.click());
await diagPage2.waitForTimeout(500);
devToolsResult.simulateButtonProducedToast = await page.evaluate(() => !!document.getElementById('sra-sim-toast'));
await diagPage2.close();

// ── Colour highlight persistence (item 25) ───────────────────────────────
// This predates the sequenced items (a pre-existing, undocumented feature —
// see the project notes' item-25 note), verified end to end here rather than
// assumed: real creation via a real Ctrl+drag-shaped gesture, reload
// survival, deletion actually removing the storage entry (not just the
// DOM), anchoring surviving content shifting around the highlighted text,
// anchoring failing silently (no misattached mark) when the text is truly
// gone, and both the per-document and cross-document storage caps.
async function readHighlightStore() {
  const helper = await ctx.newPage();
  await helper.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  const store = await helper.evaluate(() => new Promise((r) =>
    chrome.storage.local.get({ sra_text_highlights: {} }, (res) => r(res.sra_text_highlights))));
  await helper.close();
  return store;
}
async function writeHighlightStore(store) {
  const helper = await ctx.newPage();
  await helper.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  await helper.evaluate((s) => new Promise((r) => chrome.storage.local.set({ sra_text_highlights: s }, r)), store);
  await helper.close();
}

const HL_URL_KEY = 'localhost/hl-fixture.html';
const HL_PHRASE  = 'real but weak, and it becomes';

// Real Ctrl+drag needs a real MouseEvent dispatched on the element under
// the selection, not on `document` — dispatching on document left the
// content script's mouseup listener seeing an empty window.getSelection()
// in earlier attempts to write this check, so it never fired at all.
async function selectAndCtrlDrag(hlPage, phrase) {
  const pt = await hlPage.evaluate((ph) => {
    // Search every text node under <body>, not just #hl-target — item 26's
    // second-phrase check lives in the fixture's second paragraph.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let textNode = null;
    let start = -1;
    let n;
    while ((n = walker.nextNode())) {
      const i = n.textContent.indexOf(ph);
      if (i !== -1) { textNode = n; start = i; break; }
    }
    if (!textNode) throw new Error(`selectAndCtrlDrag: phrase not found on page: ${ph}`);
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + ph.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const r = range.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, phrase);
  await hlPage.evaluate((p) => {
    const el = document.elementFromPoint(p.x, p.y);
    (el || document).dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true, cancelable: true, ctrlKey: true, clientX: p.x, clientY: p.y, view: window,
    }));
  }, pt);
  await hlPage.waitForTimeout(400);
}

let highlightResult;
try {
  await writeHighlightStore({}); // start clean

  // Round trip: real creation via the real UI, then survives a reload.
  const hlPage = await ctx.newPage();
  await hlPage.goto('http://localhost:8731/hl-fixture.html');
  await hlPage.waitForTimeout(600);
  await selectAndCtrlDrag(hlPage, HL_PHRASE);
  const pickerVisible = await hlPage.evaluate(() => !!document.getElementById('sra-color-picker'));
  if (pickerVisible) {
    await hlPage.evaluate(() => document.querySelector('#sra-color-picker button[title="Yellow"]').click());
    await hlPage.waitForTimeout(400);
  }
  const afterCreate = await hlPage.evaluate(() => ({
    markCount: document.querySelectorAll('mark[data-sra-hl-id]').length,
    text: document.querySelector('mark[data-sra-hl-id]')?.textContent,
  }));

  await hlPage.reload();
  await hlPage.waitForTimeout(800);
  const afterReload = await hlPage.evaluate(() => ({
    markCount: document.querySelectorAll('mark[data-sra-hl-id]').length,
    text: document.querySelector('mark[data-sra-hl-id]')?.textContent,
  }));

  // Deletion: double-click removes the DOM mark and the storage entry, and
  // both stay gone after a further reload.
  await hlPage.evaluate(() => document.querySelector('mark[data-sra-hl-id]')
    ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  await hlPage.waitForTimeout(400);
  const afterDeleteDom = await hlPage.evaluate(() => document.querySelectorAll('mark[data-sra-hl-id]').length);
  const storeAfterDelete = await readHighlightStore();
  await hlPage.reload();
  await hlPage.waitForTimeout(800);
  const afterDeleteReload = await hlPage.evaluate(() => document.querySelectorAll('mark[data-sra-hl-id]').length);
  await hlPage.close();

  // Anchoring survives content shifting: seed a highlight for this document,
  // then load a version with three new paragraphs inserted before the
  // target — same urlKey (the query string is not part of it), but the
  // highlighted text now sits at a completely different absolute position.
  await writeHighlightStore({
    [HL_URL_KEY]: [{
      id: 'sra-hl-shift-test', text: HL_PHRASE, color: '#FFF59D', colorKey: 'yellow',
      ctxBefore: 'he eyes point and what the mind does is',
      ctxAfter: 'weaker as the measurement apparatus bec',
      paragraphIndex: 0,
      url: 'http://localhost:8731/hl-fixture.html', title: 'test', timestamp: Date.now(),
    }],
  });
  const shiftPage = await ctx.newPage();
  await shiftPage.goto('http://localhost:8731/hl-fixture.html?insert=1');
  await shiftPage.waitForTimeout(800);
  const survivesShift = await shiftPage.evaluate(() => ({
    markCount: document.querySelectorAll('mark[data-sra-hl-id]').length,
    text: document.querySelector('mark[data-sra-hl-id]')?.textContent,
  }));
  await shiftPage.close();

  // Restores after SPA navigation, not just full page load. Found while
  // building this: content.js's history.pushState/replaceState monkey-patch
  // runs in the content script's isolated world, which does not propagate
  // to the page's own main-world `history` object — confirmed directly by
  // reading history.pushState.toString() from a page.evaluate() call (main
  // world) after the patch runs, and it is still `[native code]`. A real
  // SPA framework's own routing code calls pushState from the main world
  // too, so onSpaNavigate() never actually fires from a real route change
  // via pushState — only popstate (browser back/forward) does, since that
  // is a genuine DOM event delivered to both worlds. This test exercises
  // the one path that is actually reachable (popstate via history.back())
  // rather than pushState, which would silently prove nothing.
  await writeHighlightStore({}); // clean — the seed below must land after page load, not before
  const spaPage = await ctx.newPage();
  await spaPage.goto('http://localhost:8731/'); // hostname+pathname 'localhost/' — the base article page
  await spaPage.waitForTimeout(600);
  const beforeSeed = await spaPage.evaluate(() => document.querySelectorAll('mark[data-sra-hl-id]').length);

  // Seed only now, simulating a highlight that exists in storage (made in
  // another tab, say) but that this already-open, already-restored tab has
  // not rendered — nothing should pick it up until something re-triggers
  // restoration.
  await writeHighlightStore({
    'localhost/': [{
      id: 'sra-hl-spa-test', text: HL_PHRASE, color: '#FFF59D', colorKey: 'yellow',
      ctxBefore: 'he eyes point and what the mind does is',
      ctxAfter: 'weaker as the measurement apparatus bec',
      paragraphIndex: 0, url: 'http://localhost:8731/', title: 'test', timestamp: Date.now(),
    }],
  });
  const beforeSpaNav = await spaPage.evaluate(() => document.querySelectorAll('mark[data-sra-hl-id]').length);
  await spaPage.evaluate(() => { history.pushState({}, '', '/#/route-a'); history.back(); });
  await spaPage.waitForTimeout(700); // restoreTextHighlights() fires via a 300ms setTimeout in onSpaNavigate()
  const afterSpaNav = await spaPage.evaluate(() => ({
    markCount: document.querySelectorAll('mark[data-sra-hl-id]').length,
    text: document.querySelector('mark[data-sra-hl-id]')?.textContent,
  }));
  await spaPage.close();

  // Fails silently when the text is genuinely gone — no misattached mark,
  // no thrown error, and the entry stays in storage rather than being
  // deleted on a failed match (a later visit might succeed).
  await writeHighlightStore({
    [HL_URL_KEY]: [{
      id: 'sra-hl-miss-test', text: 'this exact phrase does not exist anywhere on this fixture page',
      color: '#FFF59D', colorKey: 'yellow', ctxBefore: '', ctxAfter: '', paragraphIndex: 0,
      url: 'http://localhost:8731/hl-fixture.html', title: 'test', timestamp: Date.now(),
    }],
  });
  const missPage = await ctx.newPage();
  const missPageErrors = [];
  missPage.on('pageerror', (e) => missPageErrors.push(e.message));
  await missPage.goto('http://localhost:8731/hl-fixture.html');
  await missPage.waitForTimeout(800);
  const missMarkCount = await missPage.evaluate(() => document.querySelectorAll('mark[data-sra-hl-id]').length);
  const storeAfterMiss = await readHighlightStore();
  await missPage.close();

  // Caps: a document already at the per-document cap drops its oldest entry
  // when one more is added; a store already at the document cap drops the
  // least-recently-touched *document* when a highlight lands on a new one.
  const manyEntries = Array.from({ length: 100 }, (_, i) => ({
    id: `sra-hl-cap-${i}`, text: `filler text number ${i} padded out`, color: '#FFF59D', colorKey: 'yellow',
    ctxBefore: '', ctxAfter: '', paragraphIndex: 0,
    url: 'http://localhost:8731/hl-fixture.html', title: 'test', timestamp: 1000 + i,
  }));
  const manyDocs = {};
  for (let i = 0; i < 150; i++) {
    manyDocs[`example${i}.test/`] = [{
      id: `sra-hl-doc-${i}`, text: 'irrelevant', color: '#FFF59D', colorKey: 'yellow',
      ctxBefore: '', ctxAfter: '', paragraphIndex: 0, url: `http://example${i}.test/`, title: '', timestamp: i,
    }];
  }
  await writeHighlightStore({ ...manyDocs, [HL_URL_KEY]: manyEntries });

  const capPage = await ctx.newPage();
  await capPage.goto('http://localhost:8731/hl-fixture.html');
  await capPage.waitForTimeout(600);
  await selectAndCtrlDrag(capPage, HL_PHRASE);
  const capPickerVisible = await capPage.evaluate(() => !!document.getElementById('sra-color-picker'));
  if (capPickerVisible) {
    await capPage.evaluate(() => document.querySelector('#sra-color-picker button[title="Yellow"]').click());
    await capPage.waitForTimeout(400);
  }
  await capPage.close();
  const storeAfterCapWrite = await readHighlightStore();

  highlightResult = {
    attempted: true,
    pickerVisible,
    roundTrip: { afterCreate, afterReload },
    deletion: {
      domClearedImmediately: afterDeleteDom === 0,
      removedFromStorage: (storeAfterDelete[HL_URL_KEY]?.length ?? 0) === 0,
      staysGoneAfterReload: afterDeleteReload === 0,
    },
    survivesContentShift: survivesShift,
    restoresAfterSpaNavigation: { beforeSeed, beforeSpaNav, afterSpaNav },
    failsSilentlyWhenTextGone: {
      markCount: missMarkCount,
      pageErrors: missPageErrors.length,
      entryKeptInStorageForRetry: (storeAfterMiss[HL_URL_KEY]?.length ?? 0) > 0,
    },
    caps: {
      perDocCapHeld: (storeAfterCapWrite[HL_URL_KEY]?.length ?? 0) <= 100,
      globalDocCapHeld: Object.keys(storeAfterCapWrite).length <= 150,
      evictedTheActualOldestDoc: !('example0.test/' in storeAfterCapWrite),
    },
  };
} catch (e) {
  highlightResult = { attempted: true, error: String((e && e.message) || e) };
}
// Clean the highlight store so it doesn't bleed into a re-run.
await writeHighlightStore({});

// ── Two highlight toggles (item 26) ──────────────────────────────────────
// Highlight colour (free, client-only) and summarise-on-highlight (spends
// an assist) are independent settings — this exercises all four
// combinations for real, plus that a setting change reaches an
// already-open tab without a reload.
async function setHighlightToggles(colorOn, summarizeOn) {
  const helper = await ctx.newPage();
  await helper.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  await helper.evaluate((s) => new Promise((r) => chrome.storage.local.set({
    sra_highlight_color: s.colorOn, sra_highlight_summarize: s.summarizeOn,
    sra_text_highlights: {}, // clear so item 25's restore never masks this run's fresh phrase
  }, r)), { colorOn, summarizeOn });
  await helper.close();
}

let toggleResult;
try {
  const combos = [
    { colorOn: true,  summarizeOn: false, label: 'colour ON, summarize OFF (default)' },
    { colorOn: true,  summarizeOn: true,  label: 'colour ON, summarize ON' },
    { colorOn: false, summarizeOn: true,  label: 'colour OFF, summarize ON (summary only)' },
    { colorOn: false, summarizeOn: false, label: 'colour OFF, summarize OFF' },
  ];
  const combosResult = [];
  for (const { colorOn, summarizeOn, label } of combos) {
    await setHighlightToggles(colorOn, summarizeOn);
    const before = apiHits.summarize;
    const tPage = await ctx.newPage();
    await tPage.goto('http://localhost:8731/hl-fixture.html');
    await tPage.waitForTimeout(600);
    await selectAndCtrlDrag(tPage, HL_PHRASE);
    if (colorOn) {
      const pv = await tPage.evaluate(() => !!document.getElementById('sra-color-picker'));
      if (pv) {
        await tPage.evaluate(() => document.querySelector('#sra-color-picker button[title="Yellow"]').click());
        await tPage.waitForTimeout(500);
      }
    }
    const outcome = await tPage.evaluate(() => ({
      markCount: document.querySelectorAll('mark[data-sra-hl-id]').length,
      popupShown: !!document.querySelector('.sra-popup.show'),
    }));
    await tPage.close();
    combosResult.push({
      label,
      markCreated: outcome.markCount > 0,
      popupShown: outcome.popupShown,
      serverCallMade: apiHits.summarize > before,
    });
  }

  // Settings change reaching an already-open tab without a reload: start on
  // colour-only (no summarize), confirm no server call, then broadcast a
  // live settings change to the SAME tab and confirm the very next
  // highlight (a different phrase, so it cannot collide with the first)
  // now triggers a summary — with no navigation in between.
  await setHighlightToggles(true, false);
  const livePage = await ctx.newPage();
  await livePage.goto('http://localhost:8731/hl-fixture.html');
  await livePage.waitForTimeout(600);
  await selectAndCtrlDrag(livePage, HL_PHRASE);
  const firstPickerVisible = await livePage.evaluate(() => !!document.getElementById('sra-color-picker'));
  if (firstPickerVisible) {
    await livePage.evaluate(() => document.querySelector('#sra-color-picker button[title="Yellow"]').click());
    await livePage.waitForTimeout(500);
  }
  const beforeLiveChange = apiHits.summarize;

  await sendToArticleTab({ type: 'settings', highlightSummarize: true }, 'http://localhost:8731/hl-fixture.html');
  // Snapshot right after the broadcast, before the second highlight fires —
  // proves the settings message itself makes no server call on its own.
  const afterBroadcastBeforeSecondHighlight = apiHits.summarize;
  const SECOND_PHRASE = 'unrelated paragraph so the page';
  await selectAndCtrlDrag(livePage, SECOND_PHRASE);
  const secondPickerVisible = await livePage.evaluate(() => !!document.getElementById('sra-color-picker'));
  if (secondPickerVisible) {
    await livePage.evaluate(() => document.querySelector('#sra-color-picker button[title="Yellow"]').click());
    await livePage.waitForTimeout(500);
  }
  const liveUpdateResult = {
    noServerCallBeforeChange: beforeLiveChange === afterBroadcastBeforeSecondHighlight, // sanity: broadcast alone made no call
    serverCallAfterLiveChange: apiHits.summarize > afterBroadcastBeforeSecondHighlight,
  };
  await livePage.close();

  toggleResult = { attempted: true, combos: combosResult, liveSettingsUpdate: liveUpdateResult };
} catch (e) {
  toggleResult = { attempted: true, error: String((e && e.message) || e) };
}
await writeHighlightStore({});

// ── Persisted highlight explanations (item 36) ────────────────────────────
// Item 34 left "Save an explanation with each highlight" as a pure,
// honestly-worded rename because the underlying explanation was never
// actually kept — only shown once in a transient popup (see the project notes'
// item-34 finding). This item makes the label true: the fetched
// explanation is now patched back onto the same sra_text_highlights entry
// (matched by id) and rendered, collapsed by default, on the Highlights
// page. Separate from — and untouched by this item — sra_highlights, the
// unrelated selection-summary path's own storage key.
let explanationResult;
try {
  // (a) Toggle on: the highlight stores an explanation, and it renders on
  // the Highlights page, collapsed (a <details> with no `open` attribute)
  // until expanded.
  await setHighlightToggles(true, true); // also clears sra_text_highlights
  const beforeOn = apiHits.summarize;
  const onPage = await ctx.newPage();
  await onPage.goto('http://localhost:8731/hl-fixture.html');
  await onPage.waitForTimeout(600);
  await selectAndCtrlDrag(onPage, HL_PHRASE);
  if (await onPage.evaluate(() => !!document.getElementById('sra-color-picker'))) {
    await onPage.evaluate(() => document.querySelector('#sra-color-picker button[title="Yellow"]').click());
    await onPage.waitForTimeout(600); // fetchSummary() + the storage patch after it
  }
  await onPage.close();
  const storeAfterOn = await readHighlightStore();
  const onEntry = (storeAfterOn[HL_URL_KEY] || [])[0];

  const listPage = await ctx.newPage();
  await listPage.goto(`chrome-extension://${extId}/src/popup/highlights.html`);
  await listPage.waitForTimeout(400);
  const renderedOn = await listPage.evaluate(() => {
    const d = document.querySelector('.hl-explanation');
    return {
      exists: !!d,
      collapsedByDefault: d ? !d.open : null,
      shownText: d?.querySelector('.hl-explanation-text')?.textContent || null,
    };
  });
  await listPage.close();

  // (b) Toggle off: no explanation stored, and no server call made at all —
  // not even one that got discarded.
  await setHighlightToggles(true, false); // also clears sra_text_highlights
  const beforeOff = apiHits.summarize;
  const offPage = await ctx.newPage();
  await offPage.goto('http://localhost:8731/hl-fixture.html');
  await offPage.waitForTimeout(600);
  await selectAndCtrlDrag(offPage, HL_PHRASE);
  if (await offPage.evaluate(() => !!document.getElementById('sra-color-picker'))) {
    await offPage.evaluate(() => document.querySelector('#sra-color-picker button[title="Yellow"]').click());
    await offPage.waitForTimeout(400);
  }
  await offPage.close();
  const storeAfterOff = await readHighlightStore();
  // Snapshotted here, not re-read later — (c) and (e) below make their own
  // real calls, and a live re-read at the end would wrongly count those
  // against this step's "no call" assertion.
  const noServerCallInToggleOff = apiHits.summarize === beforeOff;

  // (c) Fetch failure: the colour mark and its storage entry still land
  // (invariant 9 — the mark that already succeeded is not undone by an AI
  // call that failed), but with no explanation, and — since
  // nextSummarizeBehavior self-clears after exactly one response — no
  // retry spending a second assist the reader never asked for.
  await setHighlightToggles(true, true); // also clears sra_text_highlights
  nextSummarizeBehavior = 'poison';
  const beforeFail = apiHits.summarize;
  const failPage = await ctx.newPage();
  const failPageErrors = [];
  failPage.on('pageerror', (e) => failPageErrors.push(e.message));
  await failPage.goto('http://localhost:8731/hl-fixture.html');
  await failPage.waitForTimeout(600);
  await selectAndCtrlDrag(failPage, HL_PHRASE);
  if (await failPage.evaluate(() => !!document.getElementById('sra-color-picker'))) {
    await failPage.evaluate(() => document.querySelector('#sra-color-picker button[title="Yellow"]').click());
    await failPage.waitForTimeout(600);
  }
  await failPage.close();
  const storeAfterFail = await readHighlightStore();
  const failEntry = (storeAfterFail[HL_URL_KEY] || [])[0];
  // Snapshotted here for the same reason as noServerCallInToggleOff above —
  // (e) below makes its own real call, and a live re-read at the end would
  // wrongly count it against this step's "exactly one attempt" assertion.
  const exactlyOneAttemptInFailStep = apiHits.summarize === beforeFail + 1;

  // (d) A pre-existing highlight with no `explanation` field at all — made
  // before this shipped, or with the toggle off — renders without error and
  // without an empty explanation slot standing in for one.
  await writeHighlightStore({
    [HL_URL_KEY]: [{
      id: 'sra-hl-no-explanation', text: HL_PHRASE, color: '#FFF59D', colorKey: 'yellow',
      ctxBefore: '', ctxAfter: '', paragraphIndex: 0,
      url: 'http://localhost:8731/hl-fixture.html', title: 'test', timestamp: Date.now(),
    }],
  });
  const legacyPage = await ctx.newPage();
  const legacyPageErrors = [];
  legacyPage.on('pageerror', (e) => legacyPageErrors.push(e.message));
  await legacyPage.goto(`chrome-extension://${extId}/src/popup/highlights.html`);
  await legacyPage.waitForTimeout(400);
  const legacyRendered = await legacyPage.evaluate(() => ({
    cardCount: document.querySelectorAll('.hl-card').length,
    explanationBlockCount: document.querySelectorAll('.hl-explanation').length,
    textShown: document.querySelector('.hl-text')?.textContent || null,
  }));
  await legacyPage.close();

  // (e) The cap holds: a long fetched explanation is truncated to 200 chars
  // before it is stored, while the popup shown at the moment of highlighting
  // still gets the full, uncapped text — the persisted copy is deliberately
  // the shorter form.
  await setHighlightToggles(true, true); // also clears sra_text_highlights
  const LONG_EXPLANATION = 'A'.repeat(500);
  nextSummarizeBehavior = LONG_EXPLANATION;
  const capPage = await ctx.newPage();
  await capPage.goto('http://localhost:8731/hl-fixture.html');
  await capPage.waitForTimeout(600);
  await selectAndCtrlDrag(capPage, HL_PHRASE);
  if (await capPage.evaluate(() => !!document.getElementById('sra-color-picker'))) {
    await capPage.evaluate(() => document.querySelector('#sra-color-picker button[title="Yellow"]').click());
    await capPage.waitForTimeout(600);
  }
  const capPopupText = await capPage.evaluate(() =>
    document.querySelector('.sra-popup.show .sra-popup-body')?.textContent || null);
  await capPage.close();
  const storeAfterCap = await readHighlightStore();
  const capEntry = (storeAfterCap[HL_URL_KEY] || [])[0];

  explanationResult = {
    attempted: true,
    toggleOn: {
      storedExplanation: onEntry?.explanation || null,
      serverCallMade: apiHits.summarize > beforeOn,
      rendered: renderedOn,
    },
    toggleOff: {
      storedExplanationAbsent: !(storeAfterOff[HL_URL_KEY] || [])[0]?.explanation,
      noServerCallMade: noServerCallInToggleOff,
    },
    fetchFailure: {
      highlightStillSaved: !!failEntry,
      noExplanationStored: !failEntry?.explanation,
      exactlyOneAttemptNoRetry: exactlyOneAttemptInFailStep,
      noPageErrors: failPageErrors.length === 0,
    },
    legacyHighlightNoExplanationField: {
      pageErrors: legacyPageErrors.length,
      cardRendered: legacyRendered.cardCount > 0,
      noExplanationBlockShown: legacyRendered.explanationBlockCount === 0,
      quotedTextStillShown: !!legacyRendered.textShown,
    },
    explanationCap: {
      popupShowedFullUncappedText: capPopupText === LONG_EXPLANATION,
      storedLength: capEntry?.explanation?.length ?? null,
      storedAtOrUnderCap: (capEntry?.explanation?.length ?? 0) <= 200,
    },
  };
} catch (e) {
  explanationResult = { attempted: true, error: String((e && e.message) || e) };
}
await writeHighlightStore({});

// ── SPA route-change detection (item 27) ───────────────────────────────────
// The isolated-world history.pushState/replaceState patch never sees a real
// page's own pushState call (see the project notes' item-25 finding, and
// background.js's header comment on the fix) — a popstate-only test proves
// nothing about this bug. /spa-fixture.html's script calls history
// .pushState() directly from the page's own MAIN-world context, exactly
// like a real SPA router, so this is the only kind of test that actually
// exercises the fix.
async function readCoverageStore() {
  const helper = await ctx.newPage();
  await helper.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  const store = await helper.evaluate(() => new Promise((r) =>
    chrome.storage.local.get({ sra_doc_coverage: {} }, (res) => r(res.sra_doc_coverage))));
  await helper.close();
  return store;
}
async function writeCoverageStore(store) {
  const helper = await ctx.newPage();
  await helper.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  await helper.evaluate((s) => new Promise((r) => chrome.storage.local.set({ sra_doc_coverage: s }, r)), store);
  await helper.close();
}

const SPA_KEY_A = 'localhost/spa-fixture.html';
const SPA_KEY_B = 'localhost/spa-fixture/article-two';

// Both fixture articles sit between two 1400px spacers so the page is tall
// enough to need real scrolling — paragraph-tracker's reading-line heuristic
// only fires a transition on an actual 'scroll' event, and a page short
// enough to fit one viewport never dispatches one. Steps through the whole
// document in viewport-sized increments so a real "enter paragraph, dwell,
// leave paragraph" sequence happens regardless of exactly where the two
// paragraphs land for a given article.
async function scrollThroughDocument(pg) {
  const docHeight = await pg.evaluate(() => document.documentElement.scrollHeight);
  const viewportH = await pg.evaluate(() => window.innerHeight);
  const step = Math.max(250, Math.floor(viewportH * 0.6));
  for (let y = 0; y <= docHeight; y += step) {
    await pg.evaluate((yy) => window.scrollTo(0, yy), y);
    await pg.waitForTimeout(400);
  }
  await pg.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await pg.waitForTimeout(400);
}

let spaResult;
try {
  await writeCoverageStore({});
  await writeHighlightStore({});
  await setHighlightToggles(true, false); // colour on, summarise off — isolate this block from item 26's leftover settings

  const spaPage = await ctx.newPage();
  const spaLogs = [];
  spaPage.on('console', (m) => spaLogs.push(m.text()));
  await spaPage.goto('http://localhost:8731/spa-fixture.html');
  await spaPage.waitForTimeout(700);

  // A real colour highlight on article one, to prove restoration also
  // reaches a genuine pushState-driven route change and back, not just the
  // popstate path item 25 was limited to testing.
  await selectAndCtrlDrag(spaPage, 'long enough paragraph to be tracked by the paragraph tracker');
  const pickerVisible = await spaPage.evaluate(() => !!document.getElementById('sra-color-picker'));
  if (pickerVisible) {
    await spaPage.evaluate(() => document.querySelector('#sra-color-picker button[title="Yellow"]').click());
    await spaPage.waitForTimeout(500);
  }
  const markCountBeforeNav = await spaPage.evaluate(() => document.querySelectorAll('mark[data-sra-hl-id]').length);

  // Read article one for real: scroll through paragraph one (a genuine
  // "left" transition registers its coverage), then stop centered on
  // paragraph two rather than scrolling on past it — paragraph two is still
  // the ACTIVE paragraph, mid-read, at the exact moment navigation happens.
  // This is the scenario paragraphTracker.reset() specifically guards:
  // without it, the reader's in-flight OLD-document paragraph would surface
  // as a "left" transition on the NEW document, carrying article one's own
  // text and stale dwell time into article two's coverage record.
  await spaPage.evaluate(() => window.scrollTo(0, 0));
  await spaPage.waitForTimeout(300);
  const p1Top = await spaPage.evaluate(() =>
    document.querySelectorAll('.spa-par')[0].getBoundingClientRect().top + window.scrollY);
  await spaPage.evaluate((y) => window.scrollTo(0, Math.max(0, y - 200)), p1Top);
  await spaPage.waitForTimeout(1200); // real dwell entering paragraph one
  await spaPage.evaluate(() => document.querySelectorAll('.spa-par')[1].scrollIntoView({ block: 'center' }));
  await spaPage.waitForTimeout(1800); // real dwell on paragraph two, still active at nav time

  const coverageBeforeNav = await readCoverageStore();

  // The real pushState-driven route change: a genuine click on the page's
  // own button, which calls history.pushState() directly from the page's
  // own script — NOT popstate, and NOT anything the extension triggers.
  await spaPage.click('#spa-nav-btn');
  await spaPage.waitForTimeout(700); // background webNavigation round trip + debounced highlight restore

  const pathAfterNav = await spaPage.evaluate(() => location.pathname);
  const markCountAfterNav = await spaPage.evaluate(() => document.querySelectorAll('mark[data-sra-hl-id]').length);

  // Read article two the same way. Reset to the top first — the browser
  // does not auto-scroll back on a pushState-only navigation, and starting
  // from wherever article one left the scroll position would skip straight
  // past article two's paragraphs without ever crossing the reading line.
  await spaPage.evaluate(() => window.scrollTo(0, 0));
  await spaPage.waitForTimeout(300);
  await scrollThroughDocument(spaPage);

  const coverageAfterArticleTwo = await readCoverageStore();

  // A query-string-only change on the SAME route must NOT be treated as a
  // new document — coverage-gate.js's documentKey() is hostname+pathname
  // only, and this fix must respect that rather than resetting on every
  // pushState call regardless of what actually changed.
  await spaPage.evaluate(() => history.pushState({}, '', location.pathname + '?utm_source=test'));
  await spaPage.waitForTimeout(500);
  const coverageAfterQueryOnlyChange = await readCoverageStore();

  // Real pushState back to article one's original pathname. The DOM is
  // restored by the page's own script as a fresh element (not the same
  // node), so a mark reappearing here can only come from a genuine
  // restoreTextHighlights() re-anchor, not from the original DOM surviving.
  await spaPage.click('#spa-back-btn');
  await spaPage.waitForTimeout(700);
  const pathAfterBack = await spaPage.evaluate(() => location.pathname);
  const markCountAfterBack = await spaPage.evaluate(() => document.querySelectorAll('mark[data-sra-hl-id]').length);

  const routeChangeLogged = spaLogs.some((l) => l.includes('SPA route change'));

  // The sharpest check in this block: paragraph two of article one was
  // still ACTIVE (mid-read, not yet "left") at the exact moment navigation
  // happened. Without paragraphTracker.reset(), that stale in-flight
  // paragraph surfaces as a "left" transition on the new document —
  // carrying its own (article-one) text as the fingerprint into article
  // two's coverage record, since documentKey() is read live at record time.
  // A fingerprint is the first 80 characters of the paragraph text
  // (fingerprint() in coverage-gate.js), so any article-one-authored
  // fingerprint appearing under keyB is direct proof of the misattribution
  // this item exists to prevent.
  const keyBFingerprints = coverageAfterArticleTwo[SPA_KEY_B]?.fingerprints || [];
  const noArticleOneTextLeakedIntoArticleTwoCoverage =
    keyBFingerprints.length > 0 && keyBFingerprints.every((fp) => !fp.startsWith('Article one'));

  spaResult = {
    realPushStateChangedUrl: pathAfterNav === '/spa-fixture/article-two',
    highlightCreatedOnArticleOne: markCountBeforeNav === 1,
    highlightGoneWhenArticleTwoSwappedIn: markCountAfterNav === 0,
    coverageAccruedForArticleOneBeforeNav: !!(coverageBeforeNav[SPA_KEY_A]?.fingerprints?.length),
    coverageAccruedForArticleTwoAfterNav: !!(coverageAfterArticleTwo[SPA_KEY_B]?.fingerprints?.length),
    articleTwoTotalParagraphsCorrect: coverageAfterArticleTwo[SPA_KEY_B]?.totalParagraphs === 2,
    noArticleOneTextLeakedIntoArticleTwoCoverage,
    articleOneCoverageUntouchedByArticleTwoReading:
      JSON.stringify(coverageAfterArticleTwo[SPA_KEY_A]) === JSON.stringify(coverageBeforeNav[SPA_KEY_A]),
    queryStringChangeKeptSameKey:
      Object.prototype.hasOwnProperty.call(coverageAfterQueryOnlyChange, SPA_KEY_B)
      && Object.keys(coverageAfterQueryOnlyChange).every((k) => k === SPA_KEY_A || k === SPA_KEY_B),
    realPushStateBackRestoredUrl: pathAfterBack === '/spa-fixture.html',
    highlightReanchoredAfterRealPushStateBack: markCountAfterBack === 1,
    routeChangeResetLoggedForDebug: routeChangeLogged,
  };
  await spaPage.close();
} catch (e) {
  spaResult = { attempted: true, error: String((e && e.message) || e) };
}
await writeCoverageStore({});
await writeHighlightStore({});

// ── PDF/PPTX viewer escape hatch (item 29) ─────────────────────────────────
// The setting itself (sra_pdf_takeover) is read by background.js's
// tabs.onUpdated redirect listener, which only fires on a real file://
// navigation — out of reach here the same way item 20 documented (needs
// "Allow access to file URLs", not scriptable from an automated headless
// run). What IS directly testable, and is exactly the part this item
// actually built: the popup toggle persists to storage correctly, and the
// viewer page's own escape-hatch button and print control exist and work.
let pdfViewerResult;
try {
  const settingsHelper = await ctx.newPage();
  await settingsHelper.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  const defaultValue = await settingsHelper.evaluate(() => new Promise((r) =>
    chrome.storage.local.get({ sra_pdf_takeover: true }, (res) => r(res.sra_pdf_takeover))));
  await settingsHelper.evaluate(() => document.getElementById('pdfTakeoverToggle').click());
  const afterToggleOff = await settingsHelper.evaluate(() => new Promise((r) =>
    chrome.storage.local.get({ sra_pdf_takeover: true }, (res) => r(res.sra_pdf_takeover))));
  await settingsHelper.evaluate(() => document.getElementById('pdfTakeoverToggle').click());
  const afterToggleBackOn = await settingsHelper.evaluate(() => new Promise((r) =>
    chrome.storage.local.get({ sra_pdf_takeover: true }, (res) => r(res.sra_pdf_takeover))));
  await settingsHelper.close();

  const pdfPage = await ctx.newPage();
  const pdfPageErrors = [];
  pdfPage.on('pageerror', (e) => pdfPageErrors.push(String(e)));
  await pdfPage.goto(`chrome-extension://${extId}/src/pdf-viewer/viewer.html?src=${encodeURIComponent('http://localhost:8731/item29-test.pdf')}`);
  await pdfPage.waitForTimeout(1500);

  const rendered = await pdfPage.evaluate(() => ({
    pageCount: document.querySelectorAll('.page-wrap').length,
    hasMarkerText: [...document.querySelectorAll('.textLayer span')]
      .some((s) => s.textContent.includes('ITEM29-PDF-MARKER')),
    hasOpenNativeBtn: !!document.getElementById('openNativeBtn'),
    hasPrintBtn: !!document.getElementById('printBtn'),
    nativeSearchFindsText: window.find ? window.find('ITEM29-PDF-MARKER') : null,
  }));

  await pdfPage.click('#openNativeBtn');
  await pdfPage.waitForTimeout(500);
  const urlAfterEscape = pdfPage.url();

  pdfViewerResult = {
    takeoverDefaultsOn: defaultValue === true,
    toggleOffPersisted: afterToggleOff === false,
    toggleBackOnPersisted: afterToggleBackOn === true,
    pdfRendered: rendered.pageCount === 1,
    textLayerHasRealText: rendered.hasMarkerText,
    nativeFindInPageWorks: rendered.nativeSearchFindsText === true,
    hasEscapeHatchButton: rendered.hasOpenNativeBtn,
    hasPrintButton: rendered.hasPrintBtn,
    escapeHatchNavigatedWithBypassFragment:
      urlAfterEscape.includes('item29-test.pdf') && urlAfterEscape.includes('#alcoia-open-native'),
    newPageErrors: pdfPageErrors.length,
  };
  await pdfPage.close();
} catch (e) {
  pdfViewerResult = { attempted: true, error: String((e && e.message) || e) };
}

// ── Web PDF takeover (item 31) ──────────────────────────────────────────────
async function setWebPdfTakeover(on) {
  const helper = await ctx.newPage();
  await helper.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  await helper.evaluate((v) => new Promise((r) => chrome.storage.local.set({ sra_web_pdf_takeover: v }, r)), on);
  await helper.close();
}

let webPdfResult;
try {
  const defaultOn = await (async () => {
    const helper = await ctx.newPage();
    await helper.goto(`chrome-extension://${extId}/src/popup/popup.html`);
    const v = await helper.evaluate(() => new Promise((r) =>
      chrome.storage.local.get({ sra_web_pdf_takeover: false }, (res) => r(res.sra_web_pdf_takeover))));
    await helper.close();
    return v;
  })();

  // Off (default): a top-level web PDF must NOT redirect.
  await setWebPdfTakeover(false);
  const offPage = await ctx.newPage();
  await offPage.goto('http://localhost:8731/item31-test.pdf', { waitUntil: 'domcontentloaded' });
  await offPage.waitForTimeout(700);
  const urlWhenOff = offPage.url();
  await offPage.close();

  // On: the same top-level web PDF must redirect to alcoia's viewer.
  await setWebPdfTakeover(true);
  const onPage = await ctx.newPage();
  await onPage.goto('http://localhost:8731/item31-test.pdf', { waitUntil: 'domcontentloaded' });
  await onPage.waitForTimeout(700);
  const urlWhenOn = onPage.url();
  await onPage.close();

  // On, but the PDF is embedded in an iframe: the TAB's own URL must never
  // change, since tabs.onUpdated only ever sees top-level navigation.
  const iframePage = await ctx.newPage();
  await iframePage.goto('http://localhost:8731/item31-iframe.html', { waitUntil: 'domcontentloaded' });
  await iframePage.waitForTimeout(700);
  const urlAfterIframeLoad = iframePage.url();
  await iframePage.close();

  // On, and the response is not a real PDF: viewer.js must fail OPEN —
  // bounce back to the original URL with the bypass fragment — rather than
  // show its own error box.
  const brokenPage = await ctx.newPage();
  const brokenPageErrors = [];
  brokenPage.on('pageerror', (e) => brokenPageErrors.push(String(e)));
  await brokenPage.goto('http://localhost:8731/item31-broken.pdf', { waitUntil: 'domcontentloaded' });
  await brokenPage.waitForTimeout(1500);
  const urlAfterBrokenLoad = brokenPage.url();
  const errorBoxShown = await brokenPage.evaluate(() => {
    const box = document.getElementById('error-box');
    return !!box && box.style.display === 'block';
  }).catch(() => null); // null if we already bounced away from the viewer page entirely
  await brokenPage.close();

  await setWebPdfTakeover(false); // restore default for anything after this block

  webPdfResult = {
    defaultsOff: defaultOn === false,
    offKeepsOriginalUrl: urlWhenOff.includes('item31-test.pdf') && !urlWhenOff.startsWith('chrome-extension://'),
    onRedirectsToAlcoiaViewer: urlWhenOn.startsWith('chrome-extension://') && urlWhenOn.includes('pdf-viewer/viewer.html'),
    iframedPdfNeverRedirectsTab: urlAfterIframeLoad.includes('item31-iframe.html') && !urlAfterIframeLoad.startsWith('chrome-extension://'),
    brokenPdfFailsOpenNotError: urlAfterBrokenLoad.includes('item31-broken.pdf') && urlAfterBrokenLoad.includes('#alcoia-open-native'),
    brokenPdfNoErrorBoxShown: errorBoxShown !== true,
    newPageErrors: brokenPageErrors.length,
  };
} catch (e) {
  webPdfResult = { attempted: true, error: String((e && e.message) || e) };
}

// ── Pin / auto-dismiss exclusivity (item 34) ────────────────────────────────
// A real popup.html load, checking the UI itself rather than just the
// source text: clicking "Keep cards until I close them" must force "Clear
// cards automatically" off and disable it, and clicking it off again must
// re-enable the other control.
let pinAutohideResult;
try {
  const popupPage = await ctx.newPage();
  await popupPage.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  await popupPage.waitForTimeout(300);

  await popupPage.evaluate(() => new Promise((r) => chrome.storage.local.set(
    { sra_autohide: true, sra_pin_default: false }, r)));
  await popupPage.reload();
  await popupPage.waitForTimeout(300);
  const beforePin = await popupPage.evaluate(() => ({
    autohideChecked: document.getElementById('autohideToggle').checked,
    autohideDisabled: document.getElementById('autohideToggle').disabled,
  }));

  await popupPage.evaluate(() => document.getElementById('pinDefaultToggle').click());
  await popupPage.waitForTimeout(150);
  const afterPinOn = await popupPage.evaluate(() => ({
    autohideChecked: document.getElementById('autohideToggle').checked,
    autohideDisabled: document.getElementById('autohideToggle').disabled,
  }));
  const storedAfterPinOn = await popupPage.evaluate(() => new Promise((r) =>
    chrome.storage.local.get({ sra_autohide: null, sra_pin_default: null }, r)));

  await popupPage.evaluate(() => document.getElementById('pinDefaultToggle').click());
  await popupPage.waitForTimeout(150);
  const afterPinOff = await popupPage.evaluate(() => ({
    autohideDisabled: document.getElementById('autohideToggle').disabled,
  }));
  await popupPage.close();

  pinAutohideResult = {
    startedWithAutohideOnPinOff: beforePin.autohideChecked === true && beforePin.autohideDisabled === false,
    turningPinOnUnchecksAutohide: afterPinOn.autohideChecked === false,
    turningPinOnDisablesAutohide: afterPinOn.autohideDisabled === true,
    contradictionNeverPersisted: storedAfterPinOn.sra_pin_default === true && storedAfterPinOn.sra_autohide === false,
    turningPinOffReenablesAutohide: afterPinOff.autohideDisabled === false,
  };
} catch (e) {
  pinAutohideResult = { attempted: true, error: String((e && e.message) || e) };
}

console.log('\n================ RESULTS ================');
console.log('article                 :', ZH ? 'article-zh.html (Chinese)' : 'article.html (English)');
console.log('content script injected :', injected.contentScript);
console.log('page errors             :', findings.pageErrors.length, findings.pageErrors.slice(0, 5));
console.log('console errors          :', findings.consoleErrors.length, findings.consoleErrors.slice(0, 8));
console.log('getUserMedia calls      :', findings.getUserMedia.length, findings.getUserMedia);
console.log('image/video in requests :', findings.mediaRequests.length, findings.mediaRequests.slice(0, 3));
console.log('popups rendered         :', popups);
console.log('overlay styling applied :', JSON.stringify(styling));
console.log('third-party requests    :', findings.thirdParty.length, [...new Set(findings.thirdParty)].slice(0, 5));
console.log('api hits                :', JSON.stringify(apiHits));
console.log('install-token attachment:', JSON.stringify(tokenAttachment), '(expect tokenIssued & everyAiRequestCarriedIt true)');
if (tokenFailureDegrade) console.log('token-endpoint fail     :', JSON.stringify(tokenFailureDegrade), '(expect all true)');
console.log('question card           :', JSON.stringify(questionCard));
console.log('after answering         :', JSON.stringify(graded));
if (correctAnswerSilence) console.log('correct-answer silence  :', JSON.stringify(correctAnswerSilence), '(expect all true)');
console.log('session recall (Alt+R)  :', JSON.stringify(recall));
console.log('receipt (Alt+I)         :', JSON.stringify(receipt));
console.log('coverage gate           :', JSON.stringify(coverage));
console.log('  survives ?query reload:', JSON.stringify(coverageAfterQueryString),
  coverageAfterQueryString.paragraphsCovered >= coverage.paragraphsCovered ? '(did not reset — good)' : '(RESET — bug)');
console.log('quiz gate (popup path)  :', JSON.stringify(quizGateBelowThreshold), '(expect ready:false, correctReason:true)');
console.log('recallBtn/receiptBtn msg:', JSON.stringify(recallStatsCheck), '(expect status:"ok" — was silently broken pre-fix)');
console.log('quiz offer card         :', JSON.stringify(offerShown));
console.log('  gone after dismiss    :', offerGoneAfterDismiss, ' stays dismissed on rescroll:', offerStaysDismissed);
console.log('quiz page (item 17)     :', JSON.stringify(quizResult));
console.log('snooze (item 18)        :', JSON.stringify(snoozeResult));
if (failureDegrade) console.log('questions-endpoint fail :', JSON.stringify(failureDegrade), '(expect all true)');
console.log('keyboard shortcuts      :', JSON.stringify(shortcuts.results));
console.log('  new page errors       :', shortcuts.newPageErrors);
console.log('diagnostics page        :', JSON.stringify(diagnostics));
console.log('diagnostics safety      :', JSON.stringify(diagSafety), '(expect all true)');
console.log('dev tools (item 33)     :', JSON.stringify(devToolsResult));
console.log('  after delete-token    :', afterDelete, '(expect "Not issued yet")');
console.log('colour highlights (25)  :', JSON.stringify(highlightResult, null, 2));
console.log('highlight toggles (26)  :', JSON.stringify(toggleResult, null, 2));
console.log('highlight explanations (36):', JSON.stringify(explanationResult, null, 2));
console.log('SPA route detection (27):', JSON.stringify(spaResult, null, 2));
console.log('PDF viewer escape hatch (29):', JSON.stringify(pdfViewerResult, null, 2));
console.log('web PDF takeover (31)   :', JSON.stringify(webPdfResult, null, 2));
console.log('pin/auto-dismiss (34)   :', JSON.stringify(pinAutohideResult, null, 2));
console.log('failed requests         :', findings.failedRequests.length, findings.failedRequests.slice(0,5));
console.log('engine/SRA logs         :', findings.engineLogs.length);
findings.engineLogs.slice(0, 25).forEach((l) => console.log('   ', l));
console.log('--- all console output (first 40) ---');
findings.allLogs.slice(0, 40).forEach((l) => console.log('   ', l));
console.log('=========================================');

await ctx.close();
server.close();
