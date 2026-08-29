/* Loads the alcoia extension unpacked in Chromium and runs the CLAUDE.md
 * verification checklist against a plain article page.
 *
 *   node tests/browser/smoke.mjs
 *
 * Checks: content script injects, no page errors, no getUserMedia call ever
 * (there is no camera path left to make one — see CLAUDE.md's migration
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

// Item 30c: a real, multi-page PDF — one genuine, real, ≥20-word paragraph
// of distinct text per page, so alcoia's own PDF viewer has real reading
// material to track across a real scroll-and-dwell session, the same way
// article.html gives the DOM path several real <p> elements to scroll
// through. One .textLayer per rendered page (viewer.js's own renderPage())
// means one paragraph-tracker candidate per page here, via
// groupTextLayerParagraphs(). Each paragraph is wrapped across several real
// Tj lines rather than one long line — a single 160+ character Tj line at
// 12pt spills far past the page's own 612pt width, and (found while
// building this check) something downstream truncates the extracted text
// for the off-page portion, silently under-counting words. Real PDFs wrap;
// this fixture now does too, which is both more realistic and what avoids
// the truncation entirely.
function wrapLines(text, maxChars = 70) {
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxChars && cur) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}
function multiPagePdfBytes(pageTexts) {
  const esc = (s) => s.replace(/([\\()])/g, '\\$1');
  const N = pageTexts.length;
  const objects = [];
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); // 1
  pageTexts.forEach((text) => {                                          // 2..N+1: content streams
    const lines = wrapLines(text, 70);
    const ops = lines.map((line, i) => `1 0 0 1 40 ${700 - i * 14} Tm (${esc(line)}) Tj`).join(' ');
    const stream = `BT /F1 12 Tf ${ops} ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  const pagesObjNum = 2 * N + 2;
  for (let i = 0; i < N; i++) {                                          // N+2..2N+1: page objects
    const contentObjNum = i + 2;
    objects.push(`<< /Type /Page /Parent ${pagesObjNum} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 1 0 R >> >> /Contents ${contentObjNum} 0 R >>`);
  }
  const kids = Array.from({ length: N }, (_, i) => `${N + 2 + i} 0 R`).join(' ');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${N} >>`);        // pagesObjNum
  objects.push(`<< /Type /Catalog /Pages ${pagesObjNum} 0 R >>`);        // catalog, == objects.length
  const catalogObjNum = objects.length;

  let out = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets.slice(1)) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogObjNum} 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}
// Comfortably past paragraph-tracker.js's 20-word floor (each is 25+ words
// by real countWords() segmentation, not just a naive space-split count).
const ITEM30C_PAGE_TEXTS = [
  'This first page of the reading test document opens right here with a real paragraph long enough to clear the paragraph tracker word floor for genuine tracking today.',
  'This second page continues the very same document with an entirely different paragraph of its own real text, also comfortably past the twenty word floor required here.',
  'This third and final page closes the document with a third distinct real paragraph, again well past the minimum word count the paragraph tracker enforces here today.',
];
const ITEM30C_MULTI_PDF_BYTES = multiPagePdfBytes(ITEM30C_PAGE_TEXTS);
const ITEM30C_PAGE_TEXTS_2 = [
  'A second, entirely separate document opens right here with its own first page paragraph, unrelated to the first test document, still comfortably past the word floor today.',
  'The second separate document continues here with its own second page paragraph, again real text distinct from every paragraph in the other test document above today.',
];
const ITEM30C_MULTI_PDF_BYTES_2 = multiPagePdfBytes(ITEM30C_PAGE_TEXTS_2);
// A "scanned" PDF: one real page, but its content stream has no text-showing
// operator at all — pdf.js's getTextContent() then returns zero items, so
// groupTextLayerParagraphs() finds zero paragraphs, exactly reproducing an
// image-only scanned document without needing to embed a real raster image.
const ITEM30C_SCANNED_PDF_BYTES = (() => {
  const objects = [
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 0 >>\nstream\n\nendstream',
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
})();

// Item 30d: a real two-column PDF (hand-built, known text positions — left
// column at x=72pt, right column at x=320pt on a 612x792pt page, same shape
// item 20 already verified for text-layer alignment) — for confirming
// rotate/fit-width/fit-page never break the correspondence between the
// canvas and its text layer, which are always built from the same pdf.js
// viewport object.
const ITEM30D_TWO_COLUMN_PDF_BYTES = (() => {
  const esc = (s) => s.replace(/([\\()])/g, '\\$1');
  const ops = [
    ...['Left column line one of real text here.', 'Left column line two continues the text.']
      .map((line, i) => `1 0 0 1 72 ${700 - i * 16} Tm (${esc(line)}) Tj`),
    ...['Right column line one of real text here.', 'Right column line two continues the text.']
      .map((line, i) => `1 0 0 1 320 ${700 - i * 16} Tm (${esc(line)}) Tj`),
  ];
  const stream = `BT /F1 12 Tf ${ops.join(' ')} ET`;
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
})();

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/item30c-multi2.pdf')) {
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    res.end(ITEM30C_MULTI_PDF_BYTES_2);
    return;
  }
  if (req.url.startsWith('/item30c-multi.pdf')) {
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    res.end(ITEM30C_MULTI_PDF_BYTES);
    return;
  }
  if (req.url.startsWith('/item30c-scanned.pdf')) {
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    res.end(ITEM30C_SCANNED_PDF_BYTES);
    return;
  }
  if (req.url.startsWith('/item30d-two-column.pdf')) {
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    res.end(ITEM30D_TWO_COLUMN_PDF_BYTES);
    return;
  }
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
  // Item 38: eight distinct, real, individually-tall paragraphs to build a
  // real session-recall pool via genuine scroll-and-dwell — the questions-
  // path rate-limit check needs several distinct real reading candidates,
  // not a synthetic one, since fetchQuestions() has no cache to short-cut
  // through and session-recall.js's pool is in-memory (built only by real
  // reading, not seedable via storage the way sra_text_highlights is).
  // Each block is tall enough that a scrollTo() by its own height reliably
  // advances exactly one paragraph regardless of the real viewport height.
  if (req.url.startsWith('/rate-limit-fixture.html')) {
    const paras = Array.from({ length: 8 }, (_, i) => `Paragraph number ${i + 1} of this rate limiting fixture ` +
      `covers an entirely distinct filler topic so that session recall treats each block as its own genuine ` +
      `reading candidate, comfortably past the forty word floor session-recall.js enforces before anything ` +
      `counts as read material worth asking a retrieval question about later on.`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body>${paras.map((t) =>
      `<div style="min-height:900px;padding-top:40px;box-sizing:border-box;"><p>${t}</p></div>`).join('')}</body></html>`);
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

// Item 13a — the self-report mechanism's three affordances. The
// persistent trigger (affordance 2) should already be on screen before
// any shortcut is pressed at all: "always available", unlike everything
// else on this page.
shortcuts.results.selfReportTriggerAlwaysPresent = await page.evaluate(() => !!document.getElementById('sra-self-report-trigger'));

await alt('KeyC');     // self-report (affordance 1)
await page.waitForTimeout(400);
shortcuts.results.altC_selfReportOptionCount = await page.evaluate(() => document.querySelectorAll('[data-self-report]').length);
// A real click in a real browser, not just markup existing — confirms the
// handler actually runs and does not throw.
await page.evaluate(() => document.querySelector('[data-self-report="confusion"]')?.click());
await page.waitForTimeout(200);
shortcuts.results.altC_clickAcknowledged = await page.evaluate(() =>
  document.querySelector('[data-self-report="confusion"]')?.textContent === 'Thanks, noted.');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// Affordance 2 — the SAME standalone card, reached by clicking the
// persistent trigger instead of the keyboard shortcut.
await page.evaluate(() => document.getElementById('sra-self-report-trigger')?.click());
await page.waitForTimeout(400);
shortcuts.results.triggerClick_selfReportOptionCount = await page.evaluate(() => document.querySelectorAll('[data-self-report]').length);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

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

    // Deletion must actually delete (CLAUDE.md) — confirmed by reopening the
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
// see CLAUDE.md's item-25 note), verified end to end here rather than
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

// ── Highlight removal affordance + persistence toggle ────────────────────
// Double-click already removed a highlight; nothing on the page ever hinted
// that it was possible. This exercises the new hover/focus-revealed chip
// (including that it never shifts the paragraph it sits over), the
// keyboard-only removal path, that chip-driven removal deletes from storage
// the same way dblclick does, and the new "keep highlights when I leave the
// page" toggle: off means a highlight still renders for the session but is
// never written to storage, and turning it off while highlights are already
// saved prompts rather than silently deleting them.
async function setHighlightPersist(persistOn) {
  const helper = await ctx.newPage();
  await helper.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  await helper.evaluate((on) => new Promise((r) => chrome.storage.local.set({
    sra_highlight_color: true, sra_highlight_summarize: false, sra_highlight_persist: on,
  }, r)), persistOn);
  await helper.close();
}

let affordanceResult;
try {
  await setHighlightPersist(true);
  await writeHighlightStore({});

  const affPage = await ctx.newPage();
  await affPage.goto('http://localhost:8731/hl-fixture.html');
  await affPage.waitForTimeout(600);
  await selectAndCtrlDrag(affPage, HL_PHRASE);
  const affPickerVisible = await affPage.evaluate(() => !!document.getElementById('sra-color-picker'));
  if (affPickerVisible) {
    await affPage.evaluate(() => document.querySelector('#sra-color-picker button[title="Yellow"]').click());
    await affPage.waitForTimeout(400);
  }

  const beforeHoverTop = await affPage.evaluate(() =>
    document.querySelector('mark[data-sra-hl-id]').closest('p, li, blockquote')?.getBoundingClientRect().top);
  await affPage.evaluate(() => document.querySelector('mark[data-sra-hl-id]')
    .dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })));
  await affPage.waitForTimeout(150);
  const chipVisibleOnHover = await affPage.evaluate(() => !!document.getElementById('sra-hl-chip'));
  const afterHoverTop = await affPage.evaluate(() =>
    document.querySelector('mark[data-sra-hl-id]').closest('p, li, blockquote')?.getBoundingClientRect().top);

  await affPage.evaluate(() => document.querySelector('mark[data-sra-hl-id]')
    .dispatchEvent(new MouseEvent('mouseleave', { bubbles: true })));
  await affPage.waitForTimeout(400); // hide is debounced (~220ms)
  const chipGoneAfterLeave = await affPage.evaluate(() => !document.getElementById('sra-hl-chip'));

  // Removal via the chip's own button deletes from storage exactly like dblclick does.
  await affPage.evaluate(() => document.querySelector('mark[data-sra-hl-id]')
    .dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })));
  await affPage.waitForTimeout(150);
  await affPage.evaluate(() => document.getElementById('sra-hl-chip')?.querySelector('button')?.click());
  await affPage.waitForTimeout(400);
  const afterChipRemoveDom = await affPage.evaluate(() => document.querySelectorAll('mark[data-sra-hl-id]').length);
  const storeAfterChipRemove = await readHighlightStore();
  await affPage.close();

  // Keyboard: focus the mark, press Delete — no mouse involved.
  await writeHighlightStore({});
  const kbPage = await ctx.newPage();
  await kbPage.goto('http://localhost:8731/hl-fixture.html');
  await kbPage.waitForTimeout(600);
  await selectAndCtrlDrag(kbPage, HL_PHRASE);
  const kbPickerVisible = await kbPage.evaluate(() => !!document.getElementById('sra-color-picker'));
  if (kbPickerVisible) {
    await kbPage.evaluate(() => document.querySelector('#sra-color-picker button[title="Yellow"]').click());
    await kbPage.waitForTimeout(400);
  }
  await kbPage.evaluate(() => document.querySelector('mark[data-sra-hl-id]').focus());
  await kbPage.keyboard.press('Delete');
  await kbPage.waitForTimeout(400);
  const afterKeyboardDeleteDom = await kbPage.evaluate(() => document.querySelectorAll('mark[data-sra-hl-id]').length);
  const storeAfterKeyboardDelete = await readHighlightStore();
  await kbPage.close();

  // Persistence off: the mark still renders for the session, but nothing
  // ever reaches storage — not written then deleted, never written.
  await setHighlightPersist(false);
  await writeHighlightStore({});
  const noPersistPage = await ctx.newPage();
  await noPersistPage.goto('http://localhost:8731/hl-fixture.html');
  await noPersistPage.waitForTimeout(600);
  await selectAndCtrlDrag(noPersistPage, HL_PHRASE);
  const noPersistPickerVisible = await noPersistPage.evaluate(() => !!document.getElementById('sra-color-picker'));
  if (noPersistPickerVisible) {
    await noPersistPage.evaluate(() => document.querySelector('#sra-color-picker button[title="Yellow"]').click());
    await noPersistPage.waitForTimeout(400);
  }
  const noPersistMarkRendered = await noPersistPage.evaluate(() =>
    document.querySelectorAll('mark[data-sra-hl-id]').length > 0);
  const storeWhilePersistOff = await readHighlightStore();
  await noPersistPage.close();
  await setHighlightPersist(true);

  affordanceResult = {
    attempted: true,
    hoverChip: {
      layoutUnchanged: beforeHoverTop === afterHoverTop,
      shownOnHover: chipVisibleOnHover,
      goneOnLeave: chipGoneAfterLeave,
    },
    chipRemoval: {
      domClearedImmediately: afterChipRemoveDom === 0,
      removedFromStorage: (storeAfterChipRemove[HL_URL_KEY]?.length ?? 0) === 0,
    },
    keyboardRemoval: {
      domClearedImmediately: afterKeyboardDeleteDom === 0,
      removedFromStorage: (storeAfterKeyboardDelete[HL_URL_KEY]?.length ?? 0) === 0,
    },
    persistenceOff: {
      markStillRendersForSession: noPersistMarkRendered,
      neverWrittenToStorage: (storeWhilePersistOff[HL_URL_KEY]?.length ?? 0) === 0,
    },
  };
} catch (e) {
  affordanceResult = { attempted: true, error: String((e && e.message) || e) };
}
await writeHighlightStore({});

// Turning persistence off while stored highlights exist must prompt, not
// silently delete — dismissing the prompt (the default/safe path) keeps them.
let persistTogglePromptResult;
try {
  await writeHighlightStore({
    [HL_URL_KEY]: [{
      id: 'sra-hl-prompt-test', text: HL_PHRASE, color: '#FFF59D', colorKey: 'yellow',
      ctxBefore: '', ctxAfter: '', paragraphIndex: 0,
      url: 'http://localhost:8731/hl-fixture.html', title: 'test', timestamp: Date.now(),
    }],
  });
  const popupPage = await ctx.newPage();
  await popupPage.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  await popupPage.evaluate(() => new Promise((r) => chrome.storage.local.set({ sra_highlight_persist: true }, r)));
  await popupPage.reload();
  await popupPage.waitForTimeout(300);

  let dialogSeen = false;
  popupPage.once('dialog', (dialog) => { dialogSeen = true; dialog.dismiss(); });
  await popupPage.evaluate(() => document.getElementById('highlightPersistToggle').click());
  await popupPage.waitForTimeout(300);
  const storeAfterDismiss = await readHighlightStore();
  await popupPage.close();

  persistTogglePromptResult = {
    attempted: true,
    promptShown: dialogSeen,
    keptOnDismiss: (storeAfterDismiss[HL_URL_KEY]?.length ?? 0) > 0,
  };
} catch (e) {
  persistTogglePromptResult = { attempted: true, error: String((e && e.message) || e) };
}
await writeHighlightStore({});
await setHighlightPersist(true);

// ── Highlights sidebar (theme-aware) + click-to-exact-spot ────────────────
// The standalone Highlights page moved to an in-page sidebar reachable
// without leaving the article (the popup's button and the hover chip's
// "All highlights" link both now open it via an 'openHighlightsSidebar'
// message), with the real page still one click away through the sidebar's
// own Expand button. Both surfaces read the --alc-* tokens applyDarkMode()
// already swaps, so dark mode is exercised here rather than assumed. A
// highlight card's click target carries a ?sra_hl=<id> anchor so the reader
// lands on the exact passage, not just the top of the page.
const SIDEBAR_HL_ID = 'sra-hl-sidebar-test';
let sidebarResult;
try {
  await writeHighlightStore({
    [HL_URL_KEY]: [{
      id: SIDEBAR_HL_ID, text: HL_PHRASE, color: '#FFF59D', colorKey: 'yellow',
      ctxBefore: '', ctxAfter: '', paragraphIndex: 0,
      url: 'http://localhost:8731/hl-fixture.html', title: 'test', timestamp: Date.now(),
    }],
  });
  const HL_FIXTURE_URL = 'http://localhost:8731/hl-fixture.html';
  await sendToArticleTab({ type: 'settings', darkMode: false }, HL_FIXTURE_URL);

  const sbPage = await ctx.newPage();
  await sbPage.goto(HL_FIXTURE_URL);
  await sbPage.waitForTimeout(600);

  // The default urlPattern on sendToArticleTab ('http://localhost:8731/*')
  // can match other still-open tabs from earlier in this script (the main
  // reading-flow `page` in particular never closes) — pass the exact URL so
  // these messages land on sbPage and nowhere else, same as item 26 below.
  const openResp = await sendToArticleTab({ action: 'openHighlightsSidebar' }, HL_FIXTURE_URL);
  await sbPage.waitForTimeout(300);

  const lightState = await sbPage.evaluate(() => {
    const panel = document.getElementById('sra-hl-sidebar');
    const card  = panel?.querySelector('.hl-card');
    return {
      panelExists: !!panel,
      panelOpen: panel?.classList.contains('open') ?? false,
      cardCount: panel?.querySelectorAll('.hl-card').length ?? 0,
      fontFamily: card ? getComputedStyle(card).fontFamily : '',
      panelBg: panel ? getComputedStyle(panel).backgroundColor : '',
    };
  });

  await sendToArticleTab({ type: 'settings', darkMode: true }, HL_FIXTURE_URL);
  await sbPage.waitForTimeout(300);
  const darkPanelBg = await sbPage.evaluate(() => {
    const panel = document.getElementById('sra-hl-sidebar');
    return panel ? getComputedStyle(panel).backgroundColor : null;
  });

  // Expand: the real standalone page opens in a new tab, sidebar stays put.
  const beforeExpand = ctx.pages().length;
  await sbPage.evaluate(() => document.querySelector('#sra-hl-sidebar [data-hl-expand]').click());
  await sbPage.waitForTimeout(600);
  const expandedPage = ctx.pages().find((p) => p.url().includes('src/popup/highlights.html'));
  const expandTabOpened = ctx.pages().length > beforeExpand && !!expandedPage;
  let expandedPageState = { attempted: false };
  if (expandedPage) {
    await expandedPage.waitForTimeout(300);
    expandedPageState = {
      attempted: true,
      noTlDrText: !(await expandedPage.evaluate(() => document.body.textContent.includes('TL;DR'))),
      noEmDash: !(await expandedPage.evaluate(() => document.body.textContent.includes('—'))),
      usesJakarta: (await expandedPage.evaluate(() =>
        getComputedStyle(document.body).fontFamily)).includes('Jakarta'),
    };
    await expandedPage.close();
  }

  // Click-to-exact-spot: the card itself is the click target, not just a
  // sub-element inside it.
  const beforeCardClick = ctx.pages().length;
  await sbPage.evaluate(() => document.querySelector('#sra-hl-sidebar .hl-card').click());
  await sbPage.waitForTimeout(700);
  const destPage = ctx.pages()[ctx.pages().length - 1];
  const destOpened = ctx.pages().length > beforeCardClick;
  const destUrl = destOpened ? destPage.url() : '';
  let landedOnExactSpot = { attempted: false };
  if (destOpened) {
    await destPage.waitForTimeout(700); // restoreTextHighlights() + scrollToRequestedHighlight()
    landedOnExactSpot = {
      attempted: true,
      urlCarriedAnchorParam: destUrl.includes(`sra_hl=${SIDEBAR_HL_ID}`),
      ...(await destPage.evaluate((id) => {
        const mark = document.querySelector(`mark[data-sra-hl-id="${id}"]`);
        if (!mark) return { markFound: false };
        // hl-fixture.html is only two short paragraphs — there is rarely
        // enough scrollable height for "centred" to mean anything on it, so
        // this only checks the mark actually ended up in view (it always
        // would on a page this short, scrolled or not, which is exactly why
        // flashedOnArrival below, not this, is the real signal that
        // scrollToRequestedHighlight() ran rather than the browser's default
        // landing-at-the-top).
        const r = mark.getBoundingClientRect();
        return {
          markFound: true,
          markInViewport: r.bottom > 0 && r.top < window.innerHeight,
          flashedOnArrival: mark.classList.contains('sra-nudge-highlight'),
        };
      }, SIDEBAR_HL_ID)),
    };
    await destPage.close();
  }

  await sbPage.close();

  sidebarResult = {
    attempted: true,
    openedViaPopupMessage: openResp?.status === 'ok',
    light: lightState,
    darkPanelBg,
    darkModeChangedBackground: darkPanelBg != null && darkPanelBg !== lightState.panelBg,
    expand: { newTabOpened: expandTabOpened, standalonePage: expandedPageState },
    clickToExactSpot: { newTabOpened: destOpened, ...landedOnExactSpot },
  };
} catch (e) {
  sidebarResult = { attempted: true, error: String((e && e.message) || e) };
}
await writeHighlightStore({});

// ── Persisted highlight explanations (item 36) ────────────────────────────
// Item 34 left "Save an explanation with each highlight" as a pure,
// honestly-worded rename because the underlying explanation was never
// actually kept — only shown once in a transient popup (see CLAUDE.md's
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
// page's own pushState call (see CLAUDE.md's item-25 finding, and
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
    hasPrintBtn: !!document.getElementById('printBtn'),
    nativeSearchFindsText: window.find ? window.find('ITEM29-PDF-MARKER') : null,
  }));

  // Item 39: the escape hatch moved from its own toolbar button into the
  // kebab menu, where native puts every other secondary action — still
  // reachable, just one extra click away.
  await pdfPage.click('#kebabBtn');
  await pdfPage.waitForTimeout(150);
  const hasOpenNativeInKebab = await pdfPage.evaluate(() => !!document.querySelector('[data-action="openNative"]'));
  await pdfPage.click('[data-action="openNative"]');
  await pdfPage.waitForTimeout(500);
  const urlAfterEscape = pdfPage.url();

  pdfViewerResult = {
    takeoverDefaultsOn: defaultValue === true,
    toggleOffPersisted: afterToggleOff === false,
    toggleBackOnPersisted: afterToggleBackOn === true,
    pdfRendered: rendered.pageCount === 1,
    textLayerHasRealText: rendered.hasMarkerText,
    nativeFindInPageWorks: rendered.nativeSearchFindsText === true,
    hasEscapeHatchButton: hasOpenNativeInKebab,
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

// ── PDF reading detection (item 30c) ────────────────────────────────────────
// alcoia's own detection pipeline — orchestrator.js, host.js, the signal
// detectors, coverage-gate.js — now runs inside alcoia's own PDF viewer, fed
// from paragraph-tracker.js's injected block source (item 30b) via
// pdf-handler.js's groupTextLayerParagraphs() (item 30c). This drives the
// real thing end to end: real .textLayer text extracted from a real PDF,
// real paragraph transitions from genuine scroll-and-dwell, real coverage
// recorded under the PDF's own source URL — not the shared viewer page URL
// every PDF opened here would otherwise collide on (orchestrator.js's new
// `documentKey` override option exists specifically to prevent that).
async function scrollPdfPageTextToReadingLine(pg, pageNum) {
  const target = await pg.evaluate((n) => {
    // .page-wrap-scoped: item 39's sidebar thumbnails carry the same
    // data-page attribute for their own purposes, built eagerly regardless
    // of whether the sidebar is open, so a bare [data-page] selector can
    // match a thumbnail button instead of the actual page.
    const wrap = document.querySelector(`.page-wrap[data-page="${n}"]`);
    const span = wrap && wrap.querySelector('.textLayer span');
    if (!span) return null;
    const r = span.getBoundingClientRect();
    const mid = (r.top + window.scrollY) + r.height / 2;
    return mid - window.innerHeight * 0.4;
  }, pageNum);
  if (target == null) return false;
  await pg.evaluate((y) => window.scrollTo(0, Math.max(0, y)), target);
  return true;
}

let pdfDetectionResult;
try {
  await writeCoverageStore({});

  const multiUrl   = 'http://localhost:8731/item30c-multi.pdf';
  const multi2Url  = 'http://localhost:8731/item30c-multi2.pdf';
  const scannedUrl = 'http://localhost:8731/item30c-scanned.pdf';
  const docKey1 = `pdf:${multiUrl}`;
  const docKey2 = `pdf:${multi2Url}`;

  // ── A real multi-page text PDF: real reading, real paragraphs ──────────
  const readPage = await ctx.newPage();
  const readErrors = [];
  readPage.on('pageerror', (e) => readErrors.push(String(e)));
  await readPage.goto(`chrome-extension://${extId}/src/pdf-viewer/viewer.html?src=${encodeURIComponent(multiUrl)}`);
  await readPage.waitForTimeout(1500);

  const rendered = await readPage.evaluate(() => ({
    pageCount: document.querySelectorAll('.page-wrap').length,
    joinedText: [...document.querySelectorAll('.textLayer span')].map((s) => s.textContent).join(' '),
  }));

  for (let i = 1; i <= 3; i++) {
    await scrollPdfPageTextToReadingLine(readPage, i);
    await readPage.waitForTimeout(1800);
  }
  // Leave the last page too, so its own dwell is recorded on the way out.
  await readPage.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await readPage.waitForTimeout(1800);
  await readPage.close();

  const coverageAfterFirst = await readCoverageStore();

  // ── A second, distinct PDF must get its OWN coverage record ────────────
  const read2Page = await ctx.newPage();
  const read2Errors = [];
  read2Page.on('pageerror', (e) => read2Errors.push(String(e)));
  await read2Page.goto(`chrome-extension://${extId}/src/pdf-viewer/viewer.html?src=${encodeURIComponent(multi2Url)}`);
  await read2Page.waitForTimeout(1500);
  for (let i = 1; i <= 2; i++) {
    await scrollPdfPageTextToReadingLine(read2Page, i);
    await read2Page.waitForTimeout(1800);
  }
  await read2Page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await read2Page.waitForTimeout(1800);
  await read2Page.close();

  const coverageAfterSecond = await readCoverageStore();

  // ── A scanned (image-only) PDF: real pages, empty text layer — must
  // degrade to silence, not error (invariants 5/9). ──────────────────────
  const scannedPage = await ctx.newPage();
  const scannedErrors = [];
  scannedPage.on('pageerror', (e) => scannedErrors.push(String(e)));
  await scannedPage.goto(`chrome-extension://${extId}/src/pdf-viewer/viewer.html?src=${encodeURIComponent(scannedUrl)}`);
  await scannedPage.waitForTimeout(1500);
  const scannedRendered = await scannedPage.evaluate(() => ({
    pageCount: document.querySelectorAll('.page-wrap').length,
    spanCount: document.querySelectorAll('.textLayer span').length,
  }));
  await scannedPage.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await scannedPage.waitForTimeout(2500);
  await scannedPage.close();

  const coverageAfterScanned = await readCoverageStore();

  await writeCoverageStore({});

  pdfDetectionResult = {
    attempted: true,
    rendering: {
      pageCount: rendered.pageCount,
      allThreePagesHaveRealText: ITEM30C_PAGE_TEXTS.every((t) =>
        rendered.joinedText.includes(t.split(' ').slice(0, 5).join(' '))),
    },
    coverage: {
      recordedUnderPdfSourceKey: !!coverageAfterFirst[docKey1],
      totalParagraphsMatchesPageCount: coverageAfterFirst[docKey1]?.totalParagraphs === 3,
      atLeastOneParagraphCovered: (coverageAfterFirst[docKey1]?.fingerprints?.length || 0) >= 1,
      notKeyedUnderTheSharedViewerUrl: !Object.keys(coverageAfterFirst).some((k) => k.includes('pdf-viewer/viewer.html')),
    },
    secondPdfGetsItsOwnRecord: {
      firstKeyUnchanged: JSON.stringify(coverageAfterSecond[docKey1]) === JSON.stringify(coverageAfterFirst[docKey1]),
      secondKeyRecordedSeparately: !!coverageAfterSecond[docKey2],
      secondKeyTotalParagraphsCorrect: coverageAfterSecond[docKey2]?.totalParagraphs === 2,
      keysAreDifferent: docKey1 !== docKey2,
    },
    scannedPdfDegradesToSilence: {
      pageRenderedButNoText: scannedRendered.pageCount === 1 && scannedRendered.spanCount === 0,
      noCoverageRecordCreated: !Object.prototype.hasOwnProperty.call(coverageAfterScanned, `pdf:${scannedUrl}`),
      noPageErrors: scannedErrors.length === 0,
    },
    newPageErrors: readErrors.length + read2Errors.length,
  };
} catch (e) {
  pdfDetectionResult = { attempted: true, error: String((e && e.message) || e) };
}
await writeCoverageStore({});

// ── PDF viewer parity: fit width/page, rotate, download (item 30d) ─────────
// Native-reader parity beyond item 29's escape hatch and print. Rotate and
// the two fit modes all go through the same rebuildAllPages() → renderPage()
// path, which builds the canvas and its text layer from the SAME pdf.js
// viewport object — the real risk this item's own brief calls out is the
// two drifting apart after a scale/rotation change, not either one simply
// failing to render. Verified directly against a real two-column PDF (the
// same shape item 20 already used for alignment), not asserted from the
// outside.
// canvas.width/.height are integer attributes (assignment truncates a float
// viewport width); the text layer's CSS width/height carries the same
// pdf.js viewport value at full float precision — so a sub-pixel difference
// between them is expected and not a sign the two have drifted apart. Real
// drift would be off by many pixels (a stale scale, a stale rotation), not
// a fraction of one.
const closeEnough = (a, b) => Math.abs(a - b) < 1;

let pdfParityResult;
try {
  const twoColUrl = 'http://localhost:8731/item30d-two-column.pdf';
  const pPage = await ctx.newPage();
  const pErrors = [];
  pPage.on('pageerror', (e) => pErrors.push(String(e)));
  await pPage.goto(`chrome-extension://${extId}/src/pdf-viewer/viewer.html?src=${encodeURIComponent(twoColUrl)}`);
  await pPage.waitForTimeout(1500);

  // pdf.js's own renderTextLayer() sets the container's width/height as a
  // CSS calc()/round() expression driven by a --scale-factor custom
  // property, not a plain px string — parseFloat(el.style.width) reads NaN
  // against that, regardless of whether canvas and text layer actually
  // agree. getBoundingClientRect() reads the real, laid-out, CSS-resolved
  // size for both, which is what "does the text layer still line up with
  // the canvas" actually means, independent of how either internally
  // expresses its own CSS.
  const readViewerState = () => {
    const canvas = document.querySelector('.page-wrap canvas');
    const tl = document.querySelector('.textLayer');
    const cr = canvas ? canvas.getBoundingClientRect() : { width: 0, height: 0 };
    const tr = tl ? tl.getBoundingClientRect() : { width: 0, height: 0 };
    return {
      canvasW: canvas?.width || 0,
      canvasH: canvas?.height || 0,
      canvasRectW: cr.width, canvasRectH: cr.height,
      textLayerRectW: tr.width, textLayerRectH: tr.height,
      spanCount: document.querySelectorAll('.textLayer span').length,
      hasLeftColumnText: [...document.querySelectorAll('.textLayer span')].some((s) => s.textContent.includes('Left column')),
    };
  };

  const before = await pPage.evaluate(() => {
    const canvas = document.querySelector('.page-wrap canvas');
    const tl = document.querySelector('.textLayer');
    const cr = canvas.getBoundingClientRect();
    const tr = tl.getBoundingClientRect();
    const spans = [...document.querySelectorAll('.textLayer span')];
    const left  = spans.find((s) => s.textContent.includes('Left column'));
    const right = spans.find((s) => s.textContent.includes('Right column'));
    return {
      canvasW: canvas.width, canvasH: canvas.height,
      canvasRectW: cr.width, canvasRectH: cr.height,
      textLayerRectW: tr.width, textLayerRectH: tr.height,
      hasBothColumns: !!left && !!right,
      leftX: left ? left.getBoundingClientRect().left : null,
      rightX: right ? right.getBoundingClientRect().left : null,
    };
  });

  // Item 39: fit-width/fit-page collapsed from two toolbar buttons into two
  // entries in the zoom-percent dropdown (native has no dedicated toolbar
  // buttons for either — this is the closest native-shaped equivalent).
  async function pickZoomMenuItem(action) {
    await pPage.click('#zoomPctBtn');
    await pPage.waitForTimeout(150);
    await pPage.click(`[data-action="${action}"]`);
  }
  await pickZoomMenuItem('fitWidth');
  await pPage.waitForTimeout(700);
  const afterFitWidth = await pPage.evaluate(readViewerState);

  await pickZoomMenuItem('fitPage');
  await pPage.waitForTimeout(700);
  const beforeRotate = await pPage.evaluate(readViewerState);

  // Item 39: native offers only one rotate direction, not a left/right pair
  // — matched here by collapsing to a single clockwise #rotateBtn. Four
  // clicks (360°) returns to the pre-rotation orientation, replacing the
  // old right-then-left round trip with a same-intent one-button round trip.
  await pPage.click('#rotateBtn');
  await pPage.waitForTimeout(700);
  const afterRotate = await pPage.evaluate(readViewerState);

  await pPage.click('#rotateBtn');
  await pPage.click('#rotateBtn');
  await pPage.click('#rotateBtn');
  await pPage.waitForTimeout(700);
  const afterRotateBack = await pPage.evaluate(readViewerState);

  const [download] = await Promise.all([
    pPage.waitForEvent('download'),
    pPage.click('#downloadBtn'),
  ]);
  const downloadFilename = download.suggestedFilename();

  // Item 39: the escape hatch lives in the kebab menu now, not its own
  // toolbar button — see the item 29 check above for the full round trip;
  // this only confirms it is still present after fit/rotate/download.
  await pPage.click('#kebabBtn');
  await pPage.waitForTimeout(150);
  const escapeHatchStillPresent = await pPage.evaluate(() => !!document.querySelector('[data-action="openNative"]'));
  await pPage.keyboard.press('Escape');

  await pPage.close();

  pdfParityResult = {
    attempted: true,
    twoColumnBaseline: {
      hasBothColumns: before.hasBothColumns,
      columnsSeparatedHorizontally: before.leftX != null && before.rightX != null && before.rightX > before.leftX + 50,
      textLayerMatchesCanvas: closeEnough(before.textLayerRectW, before.canvasRectW) && closeEnough(before.textLayerRectH, before.canvasRectH),
    },
    fitWidth: {
      changedScale: afterFitWidth.canvasW !== before.canvasW,
      textLayerMatchesCanvas: closeEnough(afterFitWidth.textLayerRectW, afterFitWidth.canvasRectW) && closeEnough(afterFitWidth.textLayerRectH, afterFitWidth.canvasRectH),
      stillHasRealText: afterFitWidth.hasLeftColumnText,
    },
    fitPage: {
      rendered: beforeRotate.canvasW > 0 && beforeRotate.canvasH > 0,
      textLayerMatchesCanvas: closeEnough(beforeRotate.textLayerRectW, beforeRotate.canvasRectW) && closeEnough(beforeRotate.textLayerRectH, beforeRotate.canvasRectH),
    },
    rotate: {
      // A 90° rotation at the same scale swaps width and height — checked
      // against the state captured immediately before rotating, not the
      // very first baseline, since fit-width/fit-page already changed scale.
      dimensionsSwapped: afterRotate.canvasW === beforeRotate.canvasH && afterRotate.canvasH === beforeRotate.canvasW,
      textLayerStillMatchesCanvas: closeEnough(afterRotate.textLayerRectW, afterRotate.canvasRectW) && closeEnough(afterRotate.textLayerRectH, afterRotate.canvasRectH),
      stillHasRealText: afterRotate.hasLeftColumnText,
      spanCountUnchanged: afterRotate.spanCount === beforeRotate.spanCount,
    },
    rotateReversible: {
      backToPreRotationDimensions: afterRotateBack.canvasW === beforeRotate.canvasW && afterRotateBack.canvasH === beforeRotate.canvasH,
      textLayerStillMatchesCanvas: closeEnough(afterRotateBack.textLayerRectW, afterRotateBack.canvasRectW) && closeEnough(afterRotateBack.textLayerRectH, afterRotateBack.canvasRectH),
    },
    download: {
      triggered: !!downloadFilename,
      filename: downloadFilename,
    },
    escapeHatchStillPresent,
    newPageErrors: pErrors.length,
  };
} catch (e) {
  pdfParityResult = { attempted: true, error: String((e && e.message) || e) };
}

// ── Item 39, problem 1: device-pixel-aware rendering ────────────────────────
// The bug was invisible at devicePixelRatio 1 — this exercises 1, 2 and 3 via
// CDP's own device-metrics override (Emulation.setDeviceMetricsOverride),
// not by eye on one machine. At each ratio: the canvas backing store must
// equal its CSS size times that ratio (not the plain CSS size — the
// original bug), and the text layer must stay in CSS pixels regardless,
// verified by checking canvas and text-layer CSS boxes still exactly agree
// (same check item 30d's two-column alignment already uses) and that a
// two-column PDF's spans still fall inside the canvas's own CSS box, not
// drifted off it.
let dprResult;
try {
  const twoColUrl = 'http://localhost:8731/item30d-two-column.pdf';
  dprResult = { attempted: true, ratios: {} };
  for (const testDpr of [1, 2, 3]) {
    const dPage = await ctx.newPage();
    const cdp = await ctx.newCDPSession(dPage);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 900, deviceScaleFactor: testDpr, mobile: false,
    });
    const dErrors = [];
    dPage.on('pageerror', (e) => dErrors.push(String(e)));
    await dPage.goto(`chrome-extension://${extId}/src/pdf-viewer/viewer.html?src=${encodeURIComponent(twoColUrl)}`);
    await dPage.waitForTimeout(1500);

    const state = await dPage.evaluate((expectedDpr) => {
      const canvas = document.querySelector('.page-wrap canvas');
      const tl = document.querySelector('.textLayer');
      if (!canvas || !tl) return { attempted: false };
      const cr = canvas.getBoundingClientRect();
      const tr = tl.getBoundingClientRect();
      const cssW = parseFloat(canvas.style.width);
      const cssH = parseFloat(canvas.style.height);
      const spans = [...document.querySelectorAll('.textLayer span')].filter((s) => s.textContent.trim());
      const spansInsideCanvas = spans.every((s) => {
        const r = s.getBoundingClientRect();
        return r.left >= cr.left - 2 && r.right <= cr.right + 2 && r.top >= cr.top - 2 && r.bottom <= cr.bottom + 2;
      });
      return {
        attempted: true,
        reportedDpr: window.devicePixelRatio,
        backingStoreW: canvas.width, backingStoreH: canvas.height,
        cssW, cssH,
        // Rounding: canvas.width is an integer attribute; cssW * dpr is not necessarily.
        backingStoreMatchesCssTimesDpr:
          Math.abs(canvas.width  - Math.round(cssW * expectedDpr)) <= 1 &&
          Math.abs(canvas.height - Math.round(cssH * expectedDpr)) <= 1,
        textLayerStaysInCssPixels: Math.abs(tr.width - cr.width) < 1 && Math.abs(tr.height - cr.height) < 1,
        spanCount: spans.length,
        spansInsideCanvas,
      };
    }, testDpr);

    await dPage.close();
    dprResult.ratios[testDpr] = { ...state, newPageErrors: dErrors.length };
  }
} catch (e) {
  dprResult = { attempted: true, error: String((e && e.message) || e) };
}

// ── Item 39, problem 2: highlight overlay geometry ─────────────────────────
// A real Ctrl+drag-shaped selection spanning all three wrapped lines of
// item30c-multi.pdf's own real paragraph (the same fixture item 30c already
// uses — long enough to wrap to three lines at this font size), verifying:
// one clean rectangle per line (not one per text run), survival across
// rebuild (zoom, rotate) and resize, persistence to the same
// sra_text_highlights store the DOM path and the Highlights page/sidebar
// already read, and that a fresh selection can still be dragged straight
// through the highlighted region afterwards.
// Selects from the first span to the last span of the given page's text
// layer directly by DOM position — item30c-multi.pdf's own paragraph wraps
// to three lines at this font size (the same fixture item 30c already uses
// for real reading), so this reliably spans all three regardless of the
// exact wrapped text. Deliberately not text-matched against the fixture's
// original unwrapped sentence: pdf.js does not insert a space at a
// line-wrap point that was not an explicit character in the content
// stream, so a real Range.toString() across the wrap would not equal that
// original sentence either — matching that here would test a string this
// selection could never actually produce, not a real bug.
async function selectAndCtrlDragPdfWholePage(pg) {
  return pg.evaluate(() => {
    const layer = document.querySelector('.textLayer');
    const spans = Array.from(layer.querySelectorAll('span')).filter((s) => s.firstChild && s.textContent.trim());
    if (spans.length < 2) return { found: false, spanCount: spans.length };
    const first = spans[0], last = spans[spans.length - 1];
    const range = document.createRange();
    range.setStart(first.firstChild, 0);
    range.setEnd(last.firstChild, last.firstChild.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const text = range.toString();
    const rects = range.getClientRects();
    // Dispatch on the middle line's own span, not the bounding box's
    // midpoint — a multi-line box's vertical centre can land in the gap
    // between lines rather than on any element.
    const midRect = rects[Math.floor(rects.length / 2)] || rects[0];
    const cx = midRect.left + midRect.width / 2, cy = midRect.top + midRect.height / 2;
    document.elementFromPoint(cx, cy)?.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true, cancelable: true, ctrlKey: true, clientX: cx, clientY: cy, view: window,
    }));
    return { found: true, text, lineRectCount: rects.length };
  });
}

let pdfHighlightResult;
try {
  await writeHighlightStore({});
  const multiUrl = 'http://localhost:8731/item30c-multi.pdf';
  const pdfHlKey = `pdf:${multiUrl}`;

  const hPage = await ctx.newPage();
  const hErrors = [];
  hPage.on('pageerror', (e) => hErrors.push(String(e)));
  await hPage.goto(`chrome-extension://${extId}/src/pdf-viewer/viewer.html?src=${encodeURIComponent(multiUrl)}`);
  await hPage.waitForTimeout(1200);

  const dragResult = await selectAndCtrlDragPdfWholePage(hPage);
  await hPage.waitForTimeout(300);
  const pickerVisible = await hPage.evaluate(() => !!document.getElementById('pdf-hl-color-picker'));
  if (pickerVisible) {
    await hPage.evaluate(() => document.querySelector('#pdf-hl-color-picker button[title="yellow"]').click());
    await hPage.waitForTimeout(400);
  }

  const afterCreate = await hPage.evaluate(() => {
    const bars = document.querySelectorAll('.hl-bar');
    return { barCount: bars.length, groupCount: document.querySelectorAll('.hl-group').length };
  });
  const storeAfterCreate = await readHighlightStore();

  // Selection must still work through the overlay: drag a fresh selection
  // over the SECOND page's real text (unhighlighted) and confirm it lands.
  await scrollPdfPageTextToReadingLine(hPage, 2);
  await hPage.waitForTimeout(300);
  const secondPageSelectable = await hPage.evaluate((ph) => {
    const layers = document.querySelectorAll('.textLayer');
    const layer = layers[1];
    if (!layer) return false;
    const span = Array.from(layer.querySelectorAll('span')).find((s) => s.textContent.trim());
    if (!span) return false;
    const range = document.createRange();
    range.selectNodeContents(span.firstChild);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return sel.toString().trim().length > 0;
  }, ITEM30C_PAGE_TEXTS[1]);

  // Survive a rebuild (zoom) and a rotate.
  await hPage.click('#zoomInBtn');
  await hPage.waitForTimeout(700);
  const afterZoom = await hPage.evaluate(() => document.querySelectorAll('.hl-bar').length);

  await hPage.click('#rotateBtn');
  await hPage.waitForTimeout(700);
  const afterRotate = await hPage.evaluate(() => document.querySelectorAll('.hl-bar').length);
  await hPage.click('#rotateBtn'); await hPage.click('#rotateBtn'); await hPage.click('#rotateBtn');
  await hPage.waitForTimeout(700);

  // Survive a resize while a fit mode is active (the one case a resize
  // actually changes page layout — see viewer.js's resize handler).
  await hPage.click('#zoomPctBtn');
  await hPage.waitForTimeout(150);
  await hPage.click('[data-action="fitWidth"]');
  await hPage.waitForTimeout(500);
  await hPage.setViewportSize({ width: 900, height: 900 });
  await hPage.waitForTimeout(500);
  const afterResize = await hPage.evaluate(() => document.querySelectorAll('.hl-bar').length);

  await hPage.close();

  pdfHighlightResult = {
    attempted: true,
    dragCreatedSelection: dragResult.found,
    pickerVisible,
    threeLinesProducedThreeCleanRects: afterCreate.barCount === 3 && afterCreate.groupCount === 1,
    persistedUnderPdfKey: (storeAfterCreate[pdfHlKey]?.length || 0) === 1,
    selectionStillWorksThroughOverlay: secondPageSelectable,
    survivesZoom: afterZoom > 0,
    survivesRotate: afterRotate > 0,
    survivesResizeInFitMode: afterResize > 0,
    newPageErrors: hErrors.length,
  };
} catch (e) {
  pdfHighlightResult = { attempted: true, error: String((e && e.message) || e) };
}
await writeHighlightStore({});

// ── Item 39, problem 3: no alcoia wordmark in the PDF viewer chrome ────────
let pdfBrandResult;
try {
  const bPage = await ctx.newPage();
  await bPage.goto(`chrome-extension://${extId}/src/pdf-viewer/viewer.html?src=${encodeURIComponent('http://localhost:8731/item29-test.pdf')}`);
  await bPage.waitForTimeout(1000);
  const toolbarText = await bPage.evaluate(() => document.getElementById('toolbar').textContent);
  const toolbarHtml = await bPage.evaluate(() => document.getElementById('toolbar').innerHTML);
  pdfBrandResult = {
    attempted: true,
    noWordmarkText: !/alcoia/i.test(toolbarText),
    noWordmarkInMarkup: !/alcoia/i.test(toolbarHtml),
  };
  await bPage.close();
} catch (e) {
  pdfBrandResult = { attempted: true, error: String((e && e.message) || e) };
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

// ── Client-side AI-call rate limiting (item 38) ────────────────────────────
// A bug backstop, not entitlement enforcement — see checkAiCallBudget()'s
// own header in content.js. Two independent budgets (fetchSummary's
// 'summarize' path, fetchQuestions' 'questions' path), each with a 6-call/
// 10s burst limit. Both paths are exercised for real, not synthetically:
// the summarize burst reuses item 26's "colour off, summarize on" direct-
// summarise flow across 8 distinct phrases on /rate-limit-fixture.html; the
// questions burst builds a real 8-paragraph session-recall pool via genuine
// scroll-and-dwell (session-recall.js's pool is in-memory only — unlike
// sra_text_highlights, there is no storage key to seed directly) and then
// triggers one real recall asking for more candidates than the burst limit.
async function readDiagLog() {
  const helper = await ctx.newPage();
  await helper.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  const entries = await helper.evaluate(() => new Promise((r) =>
    chrome.storage.local.get({ sra_diag_log: [] }, (res) => r(res.sra_diag_log))));
  await helper.close();
  return entries;
}
async function clearDiagLog() {
  const helper = await ctx.newPage();
  await helper.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  await helper.evaluate(() => new Promise((r) => chrome.storage.local.set({ sra_diag_log: [] }, r)));
  await helper.close();
}

let rateLimitResult;
try {
  await clearDiagLog();

  // (a) Summarize-path burst: 8 distinct real Ctrl+drag selections, colour
  // off / summarize on (item 26's direct-summarise flow — no picker click
  // needed), each a genuinely different phrase so none is a cache hit.
  await setHighlightToggles(false, true); // also clears sra_text_highlights
  const beforeSumBurst = apiHits.summarize;
  const sumBurstPage = await ctx.newPage();
  await sumBurstPage.goto('http://localhost:8731/rate-limit-fixture.html');
  await sumBurstPage.waitForTimeout(400);
  for (let i = 1; i <= 8; i++) {
    await selectAndCtrlDrag(sumBurstPage, `Paragraph number ${i} of this rate`);
  }
  await sumBurstPage.waitForTimeout(600);
  await sumBurstPage.close();
  const summarizeCallsMade = apiHits.summarize - beforeSumBurst;

  // (b) The cache still serves an identical repeat without ever reaching
  // checkAiCallBudget() at all — it sits after fetchSummary()'s existing
  // cache-hit early return, not before it.
  const cachePage = await ctx.newPage();
  await cachePage.goto('http://localhost:8731/rate-limit-fixture.html');
  await cachePage.waitForTimeout(400);
  const beforeCacheFirst = apiHits.summarize;
  await selectAndCtrlDrag(cachePage, 'Paragraph number 1 of this rate');
  const afterCacheFirst = apiHits.summarize;
  await selectAndCtrlDrag(cachePage, 'Paragraph number 1 of this rate'); // identical text+mode
  const afterCacheSecond = apiHits.summarize;
  await cachePage.close();

  // (c) Questions-path burst, independent from (a): a real reading session
  // over all 8 paragraphs (each div is 900px tall and holds one paragraph,
  // so scrolling by its own height reliably advances exactly one paragraph
  // regardless of the real viewport height; the reading-line target is
  // computed from the actual viewport height rather than assumed).
  const qBurstPage = await ctx.newPage();
  await qBurstPage.goto('http://localhost:8731/rate-limit-fixture.html');
  await qBurstPage.waitForTimeout(400);
  const viewportH = await qBurstPage.evaluate(() => window.innerHeight);
  for (let i = 0; i < 8; i++) {
    const y = Math.max(0, Math.round(i * 900 + 40 - viewportH * 0.4));
    await qBurstPage.evaluate((yy) => window.scrollTo(0, yy), y);
    await qBurstPage.waitForTimeout(300);  // let the engine sync on the new position
    await qBurstPage.waitForTimeout(4200); // clear session-recall's MIN_DWELL_MS (4000ms)
  }
  // One more scroll to leave paragraph 8, finalising its dwell record.
  await qBurstPage.evaluate((yy) => window.scrollTo(0, yy), 8 * 900);
  await qBurstPage.waitForTimeout(400);

  const beforeQBurst = apiHits.questions;
  await sendToArticleTab({ action: 'sessionRecall', count: 8 }, 'http://localhost:8731/rate-limit-fixture.html');
  // sessionRecall's message handler responds immediately, before the async
  // fetch loop inside runSessionRecall() actually runs — wait for it here.
  await qBurstPage.waitForTimeout(4000);
  const questionsCallsMade = apiHits.questions - beforeQBurst;
  await qBurstPage.close();

  const diagAfter = await readDiagLog();
  const rateLimitEntries = diagAfter.filter((e) => /rate_limited/.test(e.message || ''));

  rateLimitResult = {
    attempted: true,
    summarizeBurst: {
      attempts: 8,
      callsMade: summarizeCallsMade,
      stoppedAtLimit: summarizeCallsMade === 6,
    },
    cacheStillServesRepeats: {
      firstCallHitNetwork: afterCacheFirst > beforeCacheFirst,
      secondCallServedFromCache: afterCacheSecond === afterCacheFirst,
    },
    questionsBurst: {
      requestedCount: 8,
      callsMade: questionsCallsMade,
      stoppedAtLimit: questionsCallsMade === 6,
      independentFromSummarizeBudget: questionsCallsMade > 0, // its own budget wasn't pre-exhausted by (a)
    },
    diagnosticsLogging: {
      totalRateLimitEntries: rateLimitEntries.length,
      // Expect at least one entry per path, and none carrying a URL or
      // passage text — diag-log.js sanitises URLs and this item must never
      // hand it either.
      hasSummarizePathEntry: rateLimitEntries.some((e) => e.context === 'summarize'),
      hasQuestionsPathEntry: rateLimitEntries.some((e) => e.context === 'questions'),
      noUrlsInMessages: rateLimitEntries.every((e) => !/https?:\/\//.test(e.message || '')),
      sampleMessage: rateLimitEntries[0]?.message || null,
    },
  };
} catch (e) {
  rateLimitResult = { attempted: true, error: String((e && e.message) || e) };
}
await setHighlightToggles(true, false); // restore the default combo for anything after this block
await writeHighlightStore({});

// ── Upgrade page: the Reader/Student buttons actually get REPLACED once
// entitled, not left showing a stale label on top of the correct
// confirmation text (a real bug, found and fixed this session).
//
// The bug: panel.css's `.btn { display: inline-flex }` and the browser's
// own built-in `[hidden] { display: none }` default have the SAME CSS
// specificity (a class selector and an attribute selector are both
// (0,0,1,0)). Author stylesheets apply after the UA stylesheet, so `.btn`
// won every tie — `readerBtn.hidden = true` set the ATTRIBUTE correctly
// (confirmed — that was never the bug) but had NO VISUAL EFFECT on a
// `.btn`-classed element, so the button stayed fully visible showing
// whatever "Waiting…"/disabled state a prior checkout attempt had left it
// in, sitting right above the correct "You're on the Reader plan" text.
// studentBtn (class="link-btn", no competing `display`) was never hit by
// this specific collision, but shared the same never-reset label/disabled
// gap.
//
// jsdom-based unit tests (tests/upgrade.test.js) CANNOT catch this: jsdom
// does not reproduce the collision at all (verified directly — a `.btn`
// rule with a conflicting `display` never beats `[hidden]` in jsdom's own
// getComputedStyle, unlike a real browser). This block is the only thing
// in this whole checklist that can actually prove the fix, since it is the
// only place code runs in a genuine Chromium layout/cascade engine.
async function readUpgradeButtonState(pg) {
  return pg.evaluate(() => {
    const el = (id) => document.getElementById(id);
    const state = (btn) => ({
      hiddenAttr: btn.hidden,
      computedDisplay: getComputedStyle(btn).display,
      actuallyHidden: getComputedStyle(btn).display === 'none',
      disabled: btn.disabled,
      text: btn.textContent,
    });
    return {
      reader: state(el('readerBtn')),
      student: state(el('studentBtn')),
      manageBtn: { hiddenAttr: el('manageBtn').hidden, actuallyVisible: getComputedStyle(el('manageBtn')).display !== 'none' },
      stateNoteText: el('readerStateNote').textContent,
    };
  });
}

let upgradeButtonResult = { attempted: false };
try {
  const entitlementsCallCounts = { free: 0, reader: 0 };
  let entitlementsShouldReturnReader = false;

  // Intercepts whatever origin config.js's ENTITLEMENTS_URL/
  // BILLING_CHECKOUT_URL actually resolve to — entitlements.js/billing.js
  // do not honour the sra_backend_url dev override the way
  // fetchSummary/fetchQuestions do (a separate, pre-existing gap, not this
  // bug), so this mock server cannot simply serve those paths itself the
  // way it already does for /api/summarize and /api/questions.
  const routePage = await ctx.newPage();
  await routePage.route('**/api/entitlements', (route) => {
    if (entitlementsShouldReturnReader) entitlementsCallCounts.reader++;
    else entitlementsCallCounts.free++;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      // Item S6 follow-up: expires must be a real date here, not null — per
      // alcoiaServer's src/entitlements/resolve.js (confirmed by reading it
      // directly), the subscription branch is the only one that ever sets
      // a non-null expires, and upgrade.js's getEntitlementSource() now
      // reads `expires !== null` as "via subscription" specifically. This
      // block models a completed CREEM CHECKOUT (a subscription), so
      // expires:null here would misrepresent it as a seat instead — this
      // is a correction to keep the mock honest, not a behaviour change.
      body: JSON.stringify(entitlementsShouldReturnReader
        ? { tier: 'reader', features: ['own_documents', 'portable_receipt', 'sync'], expires: '2099-01-01T00:00:00.000Z', hasActiveSeat: false }
        : { tier: 'free', features: [], expires: null, hasActiveSeat: false }),
    });
  });
  await routePage.route('**/api/billing/checkout', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ checkout_url: 'https://creem.test/session/smoke' }),
  }));

  // `chrome` does not exist on a blank about:blank page — navigate to an
  // extension page FIRST so storage can be seeded at all, same as every
  // other helper page in this file already has to.
  await routePage.goto(`chrome-extension://${extId}/src/popup/upgrade.html`);
  // Seed a signed-in session directly — sign-in itself is covered
  // separately (tests/account.test.js); this block is scoped to the
  // button-replacement bug specifically.
  await routePage.evaluate(() => new Promise((r) => chrome.storage.local.set(
    { sra_session: { token: 'smoke-token', email: 'smoke@example.com', expiresAt: Date.now() + 999_999 } }, r,
  )));

  // Case A: return-from-checkout in the SAME tab — the exact scenario in
  // the bug report (a stuck "Waiting…" button).
  await routePage.goto(`chrome-extension://${extId}/src/popup/upgrade.html?checkout=pending`);
  const beforeWebhook = await readUpgradeButtonState(routePage);
  entitlementsShouldReturnReader = true; // the webhook "landed" server-side
  await routePage.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await routePage.waitForFunction(
    () => document.getElementById('readerStateNote').textContent.includes("Reader plan"),
    { timeout: 5000 },
  );
  const afterReturnFromCheckout = await readUpgradeButtonState(routePage);

  // Case B: a normal page load where the account was ALREADY entitled
  // from a previous session — no checkout ever attempted in this tab, no
  // "Waiting…" label ever set. Fresh page, not a client-side reset, so a
  // genuinely new navigation.
  await routePage.goto(`chrome-extension://${extId}/src/popup/upgrade.html`);
  await routePage.waitForFunction(
    () => document.getElementById('readerStateNote').textContent.includes("Reader plan"),
    { timeout: 5000 },
  );
  const alreadyEntitledOnLoad = await readUpgradeButtonState(routePage);

  // Item S6 follow-up: entitled via a class seat, not a subscription.
  // manageBtn's own CSS (.manage-link { display: block }) is the SAME
  // specificity-collision shape as readerBtn's `.btn` rule — this block
  // exists specifically because that class of bug only ever reproduces in
  // a real browser (this file's own header), and hiding manageBtn for a
  // reason other than "not entitled at all" is genuinely new behaviour
  // this task adds, not something the prior fix was ever exercised
  // against before now.
  await routePage.route('**/api/entitlements', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ tier: 'reader', features: ['own_documents', 'portable_receipt', 'sync'], expires: null, hasActiveSeat: true }),
  }));
  await routePage.evaluate(() => new Promise((r) => chrome.storage.local.set(
    { sra_class_membership: { classId: 'smoke-class-1', seatId: 'smoke-seat-1', role: 'student', joinedAt: Date.now() } }, r,
  )));
  // Case B just cached a "subscription-active" entitlements response for
  // this same session token (entitlements.js's own 15-minute TTL cache,
  // keyed by token) — without clearing it, this navigation would silently
  // reuse that stale cache and never reach the new route handler above at
  // all, since getEntitlements() checks its cache before ever fetching.
  await routePage.evaluate(() => new Promise((r) => chrome.storage.local.remove('sra_entitlements', r)));
  await routePage.goto(`chrome-extension://${extId}/src/popup/upgrade.html`);
  await routePage.waitForFunction(
    () => document.getElementById('readerStateNote').textContent.includes('Reader access'),
    { timeout: 5000 },
  );
  const seatOnly = await readUpgradeButtonState(routePage);
  const teamsBtnState = await routePage.evaluate(() => {
    const btn = document.getElementById('teamsBtn');
    return { disabled: btn.disabled, text: btn.textContent, noteText: document.getElementById('teamsStateNote').textContent };
  });

  await routePage.close();

  upgradeButtonResult = {
    attempted: true,
    seatOnly: {
      readerActuallyHiddenInRealChromium: seatOnly.reader.actuallyHidden,
      manageBtnActuallyHiddenInRealChromium: !seatOnly.manageBtn.actuallyVisible,
      stateNoteText: seatOnly.stateNoteText,
      teamsBtnReflectsMembership: !teamsBtnState.disabled && teamsBtnState.text !== 'Coming soon',
      teamsNoteText: teamsBtnState.noteText,
    },
    beforeWebhook: {
      readerVisible: !beforeWebhook.reader.actuallyHidden,
      readerText: beforeWebhook.reader.text,
    },
    returnFromCheckout: {
      readerHiddenAttrTrue: afterReturnFromCheckout.reader.hiddenAttr,
      readerActuallyHiddenInRealChromium: afterReturnFromCheckout.reader.actuallyHidden,
      readerLabelReset: afterReturnFromCheckout.reader.text === 'Subscribe',
      readerNotDisabled: afterReturnFromCheckout.reader.disabled === false,
      studentActuallyHidden: afterReturnFromCheckout.student.actuallyHidden,
      studentLabelReset: afterReturnFromCheckout.student.text === 'start checkout',
      manageBtnActuallyVisible: afterReturnFromCheckout.manageBtn.actuallyVisible,
      confirmationText: afterReturnFromCheckout.stateNoteText,
    },
    alreadyEntitledOnNormalLoad: {
      readerActuallyHiddenInRealChromium: alreadyEntitledOnLoad.reader.actuallyHidden,
      readerLabelReset: alreadyEntitledOnLoad.reader.text === 'Subscribe',
      readerNotDisabled: alreadyEntitledOnLoad.reader.disabled === false,
      studentActuallyHidden: alreadyEntitledOnLoad.student.actuallyHidden,
      manageBtnActuallyVisible: alreadyEntitledOnLoad.manageBtn.actuallyVisible,
      confirmationText: alreadyEntitledOnLoad.stateNoteText,
    },
    entitlementsCallCounts,
  };
} catch (e) {
  upgradeButtonResult = { attempted: true, error: String((e && e.message) || e) };
}
await writeHighlightStore({}); // harmless if unrelated; keeps the pattern consistent with the rest of this file

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
console.log('highlight removal affordance + persist toggle:', JSON.stringify(affordanceResult, null, 2));
console.log('persist toggle-off prompt:', JSON.stringify(persistTogglePromptResult, null, 2));
console.log('highlights sidebar + click-to-spot:', JSON.stringify(sidebarResult, null, 2));
console.log('highlight explanations (36):', JSON.stringify(explanationResult, null, 2));
console.log('SPA route detection (27):', JSON.stringify(spaResult, null, 2));
console.log('PDF viewer escape hatch (29):', JSON.stringify(pdfViewerResult, null, 2));
console.log('PDF reading detection (30c):', JSON.stringify(pdfDetectionResult, null, 2));
console.log('PDF viewer parity (30d)  :', JSON.stringify(pdfParityResult, null, 2));
console.log('PDF dpr-aware rendering (39.1):', JSON.stringify(dprResult, null, 2));
console.log('PDF highlight overlay (39.2):', JSON.stringify(pdfHighlightResult, null, 2));
console.log('PDF viewer no wordmark (39.3):', JSON.stringify(pdfBrandResult, null, 2));
console.log('web PDF takeover (31)   :', JSON.stringify(webPdfResult, null, 2));
console.log('pin/auto-dismiss (34)   :', JSON.stringify(pinAutohideResult, null, 2));
console.log('AI-call rate limit (38) :', JSON.stringify(rateLimitResult, null, 2));
console.log('upgrade page button fix :', JSON.stringify(upgradeButtonResult, null, 2),
  '(expect readerActuallyHiddenInRealChromium/readerLabelReset/readerNotDisabled/studentActuallyHidden/manageBtnActuallyVisible all true, in BOTH returnFromCheckout and alreadyEntitledOnNormalLoad)');
console.log('failed requests         :', findings.failedRequests.length, findings.failedRequests.slice(0,5));
console.log('engine/SRA logs         :', findings.engineLogs.length);
findings.engineLogs.slice(0, 25).forEach((l) => console.log('   ', l));
console.log('--- all console output (first 40) ---');
findings.allLogs.slice(0, 40).forEach((l) => console.log('   ', l));
console.log('=========================================');

await ctx.close();
server.close();
