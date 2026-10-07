/* Real-browser check of the Teaching Intent inline focus: the unpacked extension on a page that
 * looks like an assigned reading (https://workspace.alcoia.app/a/<id>), with the backend and the
 * workspace both answered by one local HTTPS server (host-resolver-rules, self-signed cert).
 *
 *   CERT_DIR=/path/with/k.pem+c.pem node tests/browser/teaching-focus.mjs
 *
 * Checks: (1) a focus paragraph gets a question card, reported as an ordinary 'ask';
 * (2) a paragraph not in the focus list does not; (3) the same article on a path that is not
 * /a/<id> never calls teaching-focus and reports nothing. The struggling/drifting skip is covered
 * by unit tests only (it needs a live state engine). Not part of `npm test`. */
import { chromium } from 'playwright';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeKnowledgeUnitId } from '../../alcoia/src/content/signals/knowledge-unit.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '..', '..', 'alcoia');
const CERT = process.env.CERT_DIR || '/tmp/claude-0/cert';
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CHROME = process.env.CHROME || (fs.existsSync(PINNED) ? PINNED : chromium.executablePath());
const AID = '11111111-1111-4111-8111-111111111111';
const html = fs.readFileSync(path.join(HERE, 'article.html'), 'utf8');
const paraText = (id) => html.match(new RegExp(`<p id="${id}">([\\s\\S]*?)</p>`))[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const FP = process.env.FOCUS_PARA || 'p1';
const FOCUS_ID = computeKnowledgeUnitId(paraText(FP));
const SPAN = paraText(FP).split('. ')[0] + '.';

const hits = [];
const server = https.createServer({ key: fs.readFileSync(path.join(CERT, 'k.pem')), cert: fs.readFileSync(path.join(CERT, 'c.pem')) }, (req, res) => {
  const host = req.headers.host?.split(':')[0];
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
    const json = (obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify(obj)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    if (host === 'workspace.alcoia.app') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); return; }
    hits.push({ method: req.method, url: req.url, body });
    if (req.url.startsWith('/api/token')) return json({ token: 'tok' });
    if (req.url.includes('/teaching-focus')) return json({ unitIds: process.env.NO_FOCUS ? [] : [FOCUS_ID] });
    if (req.url.includes('/knowledge-state/due')) return json({ candidates: [] });
    if (req.url.includes('/api/questions')) return json({ questions: [{ id: 'q1', q: 'How is the relationship described?', options: ['Real but weak', 'Strong', 'Absent', 'Exact'], answerIndex: 0, explanation: 'Real but weak.', span: SPAN }] });
    return json({ recorded: true, logged: true });
  });
}).listen(0);
await new Promise((r) => server.once('listening', r));
const PORT = server.address().port;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-profile-'));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: true, channel: 'chromium',
  ignoreHTTPSErrors: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox', '--ignore-certificate-errors', '--no-proxy-server',
    `--host-resolver-rules=MAP server.alcoia.app 127.0.0.1:${PORT}, MAP workspace.alcoia.app 127.0.0.1:${PORT}`],
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
await sw.evaluate(() => chrome.storage.local.set({ sra_session: { token: 'sess-1', email: 'r@example.com', expiresAt: Date.now() + 3_600_000 }, sra_install_token: 'tok' }));

const cardCount = (page) => page.evaluate(() => {
  let n = 0;
  const walk = (root) => { n += root.querySelectorAll('.sra-q-badge').length; root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) walk(el.shadowRoot); }); };
  walk(document);
  return n;
});
async function read(page, ids) {
  for (const id of ids) {
    await page.evaluate((i) => document.getElementById(i).scrollIntoView({ block: 'center' }), id);
    await page.waitForTimeout(6500); // dwell
  }
}
const results = [];
const check = (name, ok) => { results.push([name, ok]); console.log(ok ? 'PASS' : 'FAIL', name); };

// 1 + 2: assigned reading
let page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`https://workspace.alcoia.app/a/${AID}`, { waitUntil: 'load' });
await page.waitForTimeout(3000);
check('teaching-focus fetched for the assignment', hits.some((h) => h.url.includes(`/api/assignments/${AID}/teaching-focus`)));
await read(page, [FP, FP === 'p1' ? 'p2' : 'p3']); // a paragraph counts as read when the reader moves on
await page.waitForTimeout(2500);
const ivs = hits.filter((h) => h.url.endsWith('/interventions') && h.method === 'POST').map((h) => JSON.parse(h.body));
const forFocus = ivs.find((b) => b.knowledge_unit_id === FOCUS_ID);
// The ordinary state engine may still ask about other paragraphs; only the focus paragraph's
// question tells the two apart, so that is what this checks (NO_FOCUS=1 is the control run).
if (process.env.NO_FOCUS) check('CONTROL (no focus list): the paragraph is not asked about', !forFocus);
else check('focus paragraph asked about, reported as an ordinary ask', !!forFocus && forFocus.type === 'ask');
check('no page errors', errors.length === 0);
await page.close();

// 4: same article, not an assignment path
hits.length = 0;
page = await ctx.newPage();
await page.goto('https://workspace.alcoia.app/assignments', { waitUntil: 'load' });
await page.waitForTimeout(3000);
await read(page, ['p2']);
await page.waitForTimeout(2000);
check('ordinary page: teaching-focus never requested', !hits.some((h) => h.url.includes('teaching-focus')));
console.log('ordinary page requests:', hits.map((h) => h.method + ' ' + h.url));
// An ordinary page may still get its normal, state-driven question (that is not this feature);
// what must not happen is anything reported against an assignment.
check('ordinary page: nothing reported against an assignment', !hits.some((h) => h.url.includes('/interventions') || h.url.includes('/outcomes')));

await ctx.close(); server.close();
const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `${failed.length} FAILED` : 'ALL PASSED');
process.exit(failed.length ? 1 : 0);
