/* build-wordfreq.mjs — regenerate the bundled word-frequency list from
 * Project Gutenberg's own public-domain catalogue.
 *
 * One-time build tooling, not part of the shipped extension — lives here in
 * tools/, alongside question-quality.mjs, never under alcoia/. Regenerate
 * with `npm run wordfreq:build` if the source corpus is ever revisited; see
 * NOTICE.md for why this replaced the previous, licensing-ambiguous list.
 *
 * SOURCE AND WHY THIS SHAPE, confirmed directly before writing this rather
 * than assumed: gutenberg.org's own robot-access policy
 * (https://www.gutenberg.org/policy/robot_access.html), fetched and read in
 * full, states plainly: "The Project Gutenberg website is intended for
 * human users only. Any perceived use of automated tools to access the
 * Project Gutenberg website will result in a temporary or permanent block
 * of your IP address. The only exceptions to this rule are below" — and the
 * sanctioned exceptions are the harvest endpoint (for bulk-listing an
 * entire filetype/language) or an official mirror. This script fetches a
 * small, curated batch of specific, known-id books — not a crawl, not the
 * harvest endpoint — so the correct, respectful choice is an official
 * mirror, not gutenberg.org itself. Uses gutenberg.pglaf.org, Project
 * Gutenberg's own high-speed mirror (listed at
 * https://www.gutenberg.org/MIRRORS.ALL, "Includes cache/generated files"),
 * with a real delay between requests regardless.
 *
 * Each raw file carries Project Gutenberg's own boilerplate header/footer
 * (their licensing terms, not the book's prose) between standard
 * "*** START/END OF THE PROJECT GUTENBERG EBOOK ***" markers — stripped
 * before counting, so frequency reflects the books themselves, not PG's own
 * legal text repeated identically in every file.
 *
 * Output: alcoia/src/libs/wordfreq/{google-10000-english.txt, common-words.js}
 * — same two filenames and shapes the previous list used (text-difficulty.js
 * imports only COMMON_WORDS from common-words.js and needs zero changes;
 * the .txt is kept alongside as a plain, human-inspectable source artifact,
 * same role the old file played, not read back by anything at runtime).
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, '..', 'alcoia', 'src', 'libs', 'wordfreq');
const MIRROR = 'https://gutenberg.pglaf.org/cache/epub';
const DELAY_MS = 1200; // polite spacing between requests to the mirror
const TARGET_LIST_SIZE = 10000;
const MIN_BOOKS_REQUIRED = 10; // refuse to build a list from too small a sample

// Curated, diverse, well-known, unambiguously public-domain titles —
// deliberately ordinary modern-ish prose (novels, essays, standard prose
// translations), not verse or archaic English, so the resulting
// frequencies describe ordinary reading — matching what this list is
// actually used to judge (text-difficulty.js's lexical-rarity and
// propositional-density measures). A book missing or moved on the mirror
// is skipped, not fatal — see fetchBook() below; the final corpus is
// whatever subset actually succeeded, reported honestly at the end, never
// padded or assumed complete.
// 4200 (Pepys' Diary, 17th-century English, ~1.3M words on its own — a
// fifth of an earlier run's corpus) was deliberately dropped after a real
// before/after comparison (see this item's own report) showed it skewing
// the list further from ordinary modern vocabulary than the rest of the
// batch; 64317 (Gatsby, 1925) and 5670 (Jacob's Room, 1922) replace it —
// genuinely 20th-century, plain prose, confirmed still on the mirror.
const BOOK_IDS = [
  1342, 11, 84, 1661, 98, 1400, 46, 730, 766, 76, 74, 345, 174, 768, 1260,
  158, 161, 5200, 2701, 219, 36, 35, 43, 120, 514, 205, 829, 2591, 1727,
  1232, 2680, 408, 1497, 33, 55, 244, 1184, 1257, 521, 145, 2554, 25344,
  16328, 6130, 2600, 105, 1998, 64317, 5670,
];

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

const START_RE = /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i;
const END_RE = /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i;

function stripBoilerplate(text) {
  const startMatch = text.match(START_RE);
  const endMatch = text.match(END_RE);
  const start = startMatch ? startMatch.index + startMatch[0].length : 0;
  const end = endMatch ? endMatch.index : text.length;
  return end > start ? text.slice(start, end) : text;
}

async function fetchBook(id) {
  const url = `${MIRROR}/${id}/pg${id}.txt`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const raw = await resp.text();
    return stripBoilerplate(raw);
  } catch (e) {
    return null;
  }
}

function tokenize(text) {
  return text.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || [];
}

async function main() {
  console.log(`Fetching up to ${BOOK_IDS.length} candidate books from ${MIRROR} ...`);
  const counts = new Map();
  let booksUsed = 0;
  let totalWords = 0;
  const usedIds = [];

  for (const id of BOOK_IDS) {
    const text = await fetchBook(id);
    if (!text || text.length < 1000) {
      console.log(`  [skip] ${id} — not available on this mirror or too short`);
      await sleep(DELAY_MS);
      continue;
    }
    const words = tokenize(text);
    for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
    totalWords += words.length;
    booksUsed += 1;
    usedIds.push(id);
    console.log(`  [ok] ${id} — ${words.length.toLocaleString()} words`);
    await sleep(DELAY_MS);
  }

  if (booksUsed < MIN_BOOKS_REQUIRED) {
    console.error(`\nOnly ${booksUsed} books fetched successfully (need at least ${MIN_BOOKS_REQUIRED}) — refusing to build a list from too small a sample. Nothing written.`);
    process.exit(1);
  }

  const sorted = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TARGET_LIST_SIZE)
    .map(([w]) => w);

  console.log(`\nBooks used: ${booksUsed}/${BOOK_IDS.length} (ids: ${usedIds.join(', ')})`);
  console.log(`Total words tokenized: ${totalWords.toLocaleString()}`);
  console.log(`Distinct words seen: ${counts.size.toLocaleString()}`);
  console.log(`Final list size: ${sorted.length.toLocaleString()}`);

  mkdirSync(OUT_DIR, { recursive: true });

  const txtPath = path.join(OUT_DIR, 'google-10000-english.txt');
  writeFileSync(txtPath, `${sorted.join('\n')}\n`, 'utf8');

  const jsPath = path.join(OUT_DIR, 'common-words.js');
  const header = `/* Generated by tools/build-wordfreq.mjs from ${booksUsed} Project Gutenberg public-domain texts (see NOTICE.md for provenance). Do not hand-edit; regenerate with \`npm run wordfreq:build\` if the source corpus ever changes. */\n`;
  const body = `export const COMMON_WORDS = new Set(${JSON.stringify(sorted)});\n`;
  writeFileSync(jsPath, header + body, 'utf8');

  console.log(`\nWrote ${txtPath}`);
  console.log(`Wrote ${jsPath}`);
}

main();
