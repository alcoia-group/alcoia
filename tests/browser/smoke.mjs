/* Loads the alcoia extension unpacked in Chromium and runs the the project notes
 * verification checklist against a plain article page.
 *
 *   node tests/browser/smoke.mjs
 *
 * Checks: content script injects, no page errors, no getUserMedia call ever
 * (there is no camera path left to make one — see the project notes' migration
 * note on removing webcam gaze), no image/video data in any request, and
 * that telemetry-only detection reaches the reader.
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

const server = http.createServer((req, res) => {
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
await diagPage.close();

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
console.log('  after delete-token    :', afterDelete, '(expect "Not issued yet")');
console.log('failed requests         :', findings.failedRequests.length, findings.failedRequests.slice(0,5));
console.log('engine/SRA logs         :', findings.engineLogs.length);
findings.engineLogs.slice(0, 25).forEach((l) => console.log('   ', l));
console.log('--- all console output (first 40) ---');
findings.allLogs.slice(0, 40).forEach((l) => console.log('   ', l));
console.log('=========================================');

await ctx.close();
server.close();
