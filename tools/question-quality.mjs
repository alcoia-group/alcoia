/* question-quality.mjs — read the questions yourself
 *
 * The pipeline is verified; the questions are not. A perfectly plumbed system
 * serving mediocre questions fails in a way that looks like "people don't want
 * interruptions" rather than "the questions were bad". Those are
 * indistinguishable in day-30 retention and they have opposite fixes.
 *
 * This does not score quality. It cannot — judging whether a question tests
 * understanding rather than word-matching is what your eyes are for. What it
 * does is run real passages through the real endpoint, apply the mechanical
 * checks that can be automated, and lay the output out so an afternoon of
 * reading is actually possible.
 *
 *   node tools/question-quality.mjs --server http://localhost:3000 \
 *        --file tests/browser/article.html --url https://en.wikipedia.org/wiki/Fourier_transform
 *
 * Needs your server running with GROQ_API_KEY set. It calls live Groq and
 * costs real tokens: roughly one generation per passage.
 *
 * WHAT TO LOOK FOR, per question:
 *   - Answerable from the passage alone, without outside knowledge?
 *   - Does it test understanding, or can you find the answer by matching a
 *     word from the question to a word in the text? The second is the common
 *     failure and the mechanical overlap check below only hints at it.
 *   - Do all three distractors look plausible to someone who skimmed? A
 *     distractor nobody would pick is a wasted option and makes a 4-way
 *     question a 2-way one.
 *   - Is the cited span really where the answer lives?
 */

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const all = (name) => args.reduce((acc, a, i) => (a === `--${name}` ? [...acc, args[i + 1]] : acc), []);

const SERVER = opt('server', 'http://localhost:3000');
const COUNT = Number(opt('count', 2));
const MIN_WORDS = Number(opt('min-words', 60));

const stop = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'is', 'are', 'was',
  'were', 'be', 'been', 'it', 'its', 'that', 'this', 'which', 'what', 'how', 'why', 'for', 'on',
  'as', 'at', 'by', 'with', 'from', 'does', 'do', 'not', 'they', 'their', 'has', 'have']);

const words = (s) => String(s).toLowerCase().match(/[a-z']+/g) || [];
const content = (s) => words(s).filter((w) => w.length > 3 && !stop.has(w));

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ');
}

function passagesFrom(text) {
  return text.split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.split(/\s+/).length >= MIN_WORDS);
}

async function loadSource(src) {
  if (/^https?:\/\//.test(src)) {
    const resp = await fetch(src, { headers: { 'User-Agent': 'tldr-question-quality/1' } });
    if (!resp.ok) throw new Error(`${src} -> HTTP ${resp.status}`);
    return stripHtml(await resp.text());
  }
  const raw = readFileSync(src, 'utf8');
  return /\.html?$/i.test(src) ? stripHtml(raw) : raw;
}

async function generate(passage) {
  const resp = await fetch(`${SERVER}/api/questions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: passage, count: COUNT, kind: 'recall' }),
  });
  if (!resp.ok) return { error: `HTTP ${resp.status} ${(await resp.text()).slice(0, 160)}` };
  return resp.json();
}

/* The checks that can be mechanised. None of these judge quality; they flag
 * shapes that are usually wrong, so your reading time goes to the real cases. */
function flagsFor(q, passage) {
  const flags = [];
  const hay = passage.toLowerCase().replace(/\s+/g, ' ');

  if (!hay.includes(String(q.span || '').toLowerCase().replace(/\s+/g, ' '))) {
    flags.push('SPAN NOT IN PASSAGE (server should have rejected this)');
  }

  // Word-matching tell: the question's content words nearly all appear in the
  // cited sentence, so the answer can be found by lexical overlap alone.
  const qw = new Set(content(q.q));
  const sw = new Set(content(q.span));
  const shared = [...qw].filter((w) => sw.has(w)).length;
  if (qw.size >= 3 && shared / qw.size > 0.7) {
    flags.push(`word-match risk: ${shared}/${qw.size} question terms sit in the cited sentence`);
  }

  // A correct option much longer than the others is the oldest tell in MCQ writing.
  const lens = q.options.map((o) => words(o).length);
  const correctLen = lens[q.answerIndex];
  const others = lens.filter((_, i) => i !== q.answerIndex);
  if (correctLen > Math.max(...others) * 1.8) flags.push('correct option is conspicuously the longest');
  if (correctLen < Math.min(...others) / 1.8) flags.push('correct option is conspicuously the shortest');

  // A distractor sharing almost nothing with the passage is one nobody picks.
  q.options.forEach((o, i) => {
    if (i === q.answerIndex) return;
    const ow = content(o);
    if (!ow.length) return;
    const inPassage = ow.filter((w) => hay.includes(w)).length / ow.length;
    if (inPassage < 0.2) flags.push(`distractor ${i + 1} barely uses the passage's vocabulary — likely a giveaway`);
  });

  if (/\b(passage|text|article|author)\b/i.test(q.q)) {
    flags.push('question refers to "the passage" rather than the subject matter');
  }
  return flags;
}

const sources = [...all('file'), ...all('url')];
if (!sources.length) {
  console.error('Usage: node tools/question-quality.mjs --server URL (--file PATH | --url URL)...');
  process.exit(1);
}

let asked = 0, returned = 0, flagged = 0, failedPassages = 0;

for (const src of sources) {
  let passages;
  try {
    passages = passagesFrom(await loadSource(src));
  } catch (e) {
    console.log(`\n### ${src}\n  could not load: ${e.message}`);
    continue;
  }

  console.log(`\n${'='.repeat(78)}\n### ${src}  —  ${passages.length} passage(s) over ${MIN_WORDS} words\n${'='.repeat(78)}`);

  for (const [i, passage] of passages.entries()) {
    asked++;
    const result = await generate(passage);

    console.log(`\n──── passage ${i + 1} (${passage.split(/\s+/).length} words) ────`);
    console.log(passage.length > 700 ? passage.slice(0, 700) + '…' : passage);

    if (result.error) { failedPassages++; console.log(`\n  !! ${result.error}`); continue; }
    if (!result.questions?.length) { failedPassages++; console.log('\n  !! no questions survived validation (422)'); continue; }

    for (const q of result.questions) {
      returned++;
      const flags = flagsFor(q, passage);
      if (flags.length) flagged++;

      console.log(`\n  Q: ${q.q}`);
      q.options.forEach((o, oi) => console.log(`     ${oi === q.answerIndex ? '*' : ' '} ${String.fromCharCode(97 + oi)}) ${o}`));
      console.log(`     why: ${q.explanation}`);
      console.log(`     cites: "${q.span.slice(0, 120)}${q.span.length > 120 ? '…' : ''}"`);
      flags.forEach((f) => console.log(`     [flag] ${f}`));
    }
  }
}

console.log(`\n${'='.repeat(78)}`);
console.log(`passages attempted    : ${asked}`);
console.log(`passages with none    : ${failedPassages}`);
console.log(`questions returned    : ${returned}`);
console.log(`questions with a flag : ${flagged}`);
console.log('\nFlags are hints, not verdicts. The judgement that matters — does this test');
console.log('understanding or word-matching — is the one you have to make by reading them.');
