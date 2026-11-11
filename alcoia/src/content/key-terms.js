/* key-terms.js — mark the passage's key words while an explanation is shown
 *
 * When an explain or repair card opens for a paragraph, up to three words or two-word phrases from that
 * paragraph are marked on the page itself. They stay until the reader removes them (hover shows a small x,
 * a click removes that one mark) or reloads the page. Settings > "Mark key words when explaining" turns
 * this off (sra_auto_key_terms, on by default; follows the account as auto_key_terms).
 *
 * How words are chosen: words the explanation reuses from the paragraph. An explanation is written to carry
 * the paragraph's main idea in plain words, so the paragraph's own terms that it repeats are the ones it
 * leans on. Two-word phrases the explanation repeats come first, then single words, scored by how often the
 * explanation uses them, then by length. This is a heuristic on the two texts, not a claim about which words
 * matter most; when the explanation shares nothing with the paragraph, nothing is marked.
 *
 * Only text nodes are touched: each mark wraps the first whole-word match in a <mark>, never inside a link,
 * button, form field, code, or anything editable, so clicking a mark never follows a link. Nothing here is
 * stored or sent anywhere.
 */

const MAX_TERMS = 3;
const MIN_LEN = 4;
const MAX_LEN = 40;
const STOP = new Set([
  'this', 'that', 'these', 'those', 'with', 'from', 'have', 'has', 'had', 'will', 'would', 'could', 'should',
  'about', 'into', 'onto', 'over', 'under', 'after', 'before', 'while', 'because', 'since', 'than', 'then',
  'were', 'been', 'being', 'they', 'them', 'their', 'there', 'where', 'when', 'what', 'which', 'whom', 'whose',
  'your', 'yours', 'also', 'only', 'just', 'more', 'most', 'some', 'such', 'each', 'every', 'both', 'either',
  'neither', 'itself', 'here', 'like', 'very', 'much', 'many', 'other', 'another', 'does', 'doing', 'done',
  'make', 'makes', 'made', 'means', 'mean', 'example', 'think', 'thing', 'things', 'something', 'paragraph',
  'passage', 'text', 'reading', 'idea', 'ideas', 'same', 'different', 'still', 'even', 'well', 'into', 'upon',
  'dans', 'pour', 'avec', 'sans', 'mais', 'donc', 'elle', 'elles', 'nous', 'vous', 'leur', 'leurs', 'cette',
  'comme', 'plus', 'tout', 'tous', 'sont', 'être', 'avoir', 'para', 'como', 'pero', 'esta', 'este', 'sobre',
]);
const CLASS = 'alcoia-key-term';
const SKIP = 'a, button, input, textarea, select, code, pre, script, style, [contenteditable=""], [contenteditable="true"], mark';

const words = (text) => String(text || '').toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) || [];
const ok = (w) => w.length >= MIN_LEN && w.length <= MAX_LEN && !STOP.has(w) && !/^\d+$/.test(w);

export function pickKeyTerms(paragraphText, explanationText, max = MAX_TERMS) {
  const para = words(paragraphText);
  const expl = words(explanationText);
  if (!para.length || !expl.length) return [];
  const paraSet = new Set(para);
  const paraPairs = new Set();
  for (let i = 0; i + 1 < para.length; i += 1) paraPairs.add(`${para[i]} ${para[i + 1]}`);

  const score = new Map();
  const add = (term, by) => score.set(term, (score.get(term) || 0) + by);
  for (let i = 0; i < expl.length; i += 1) {
    const w = expl[i];
    if (ok(w) && paraSet.has(w)) add(w, 1);
    const next = expl[i + 1];
    if (next && ok(w) && ok(next) && paraPairs.has(`${w} ${next}`)) add(`${w} ${next}`, 2);
  }
  const ranked = [...score.entries()]
    .map(([term, n]) => ({ term, n: n + (term.includes(' ') ? 1 : 0), len: term.length }))
    .sort((a, b) => b.n - a.n || b.len - a.len || a.term.localeCompare(b.term));

  const chosen = [];
  for (const { term } of ranked) {
    if (chosen.length >= max) break;
    // A word already inside a chosen phrase (or a phrase containing a chosen word) would mark the same spot twice.
    if (chosen.some((c) => c.split(' ').includes(term) || term.split(' ').includes(c))) continue;
    chosen.push(term);
  }
  return chosen;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function ensureStyle(doc) {
  if (doc.getElementById('alcoia-key-term-style')) return;
  const style = doc.createElement('style');
  style.id = 'alcoia-key-term-style';
  style.textContent = `
mark.${CLASS}{background:rgba(163,177,163,.45);color:inherit;border-radius:3px;padding:0 1px;cursor:pointer;position:relative;box-decoration-break:clone;-webkit-box-decoration-break:clone}
mark.${CLASS}:hover,mark.${CLASS}:focus-visible{background:rgba(163,177,163,.25);outline:1px dashed rgba(90,110,90,.8);outline-offset:1px}
mark.${CLASS}:hover::after,mark.${CLASS}:focus-visible::after{content:"\\00d7";position:absolute;top:-.7em;right:-.6em;font:600 11px/14px system-ui,sans-serif;width:14px;height:14px;text-align:center;border-radius:50%;background:#333;color:#fff}
mark.${CLASS}-sentence{background:rgba(201,190,232,.40)}
mark.${CLASS}-sentence:hover{background:rgba(201,190,232,.22)}
@media (prefers-reduced-motion:no-preference){mark.${CLASS}{transition:background .15s}}`;
  (doc.head || doc.documentElement).appendChild(style);
}

function unwrap(mark) {
  const parent = mark.parentNode;
  if (!parent) return;
  while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
  parent.removeChild(mark);
  parent.normalize?.();
}

// Marks the first whole-word occurrence of each term inside `el`. Returns how many were marked.
export function markKeyTerms(el, terms, { title = 'Key word from the explanation. Click to remove this mark.' } = {}) {
  if (!el || !Array.isArray(terms) || !terms.length) return 0;
  const doc = el.ownerDocument;
  if (!doc?.createTreeWalker) return 0;
  ensureStyle(doc);
  let marked = 0;
  for (const term of terms) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${term.split(' ').map(escapeRe).join('\\s+')}(?![\\p{L}\\p{N}])`, 'iu');
    const walker = doc.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */, {
      acceptNode: (n) => (n.parentElement?.closest(SKIP) ? 2 /* REJECT */ : 1 /* ACCEPT */),
    });
    let node;
    while ((node = walker.nextNode())) {
      const m = re.exec(node.nodeValue);
      if (!m) continue;
      const hit = node.splitText(m.index);
      hit.splitText(m[0].length);
      const mark = doc.createElement('mark');
      mark.className = CLASS;
      mark.tabIndex = 0;
      mark.title = title;
      mark.setAttribute('aria-label', `${m[0]}, key word. Press Enter to remove the mark.`);
      hit.parentNode.insertBefore(mark, hit);
      mark.appendChild(hit);
      const remove = (e) => { e.preventDefault(); e.stopPropagation(); unwrap(mark); };
      mark.addEventListener('click', remove);
      mark.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'Delete') remove(e); });
      marked += 1;
      break;
    }
  }
  return marked;
}

export function clearKeyTerms(root) {
  for (const m of [...(root?.querySelectorAll?.(`mark.${CLASS}`) || [])]) unwrap(m);
}

// ── The central sentence ─────────────────────────────────────────────────────
// Sometimes one sentence carries a paragraph: the others restate it, give an example of it or lead up to it. Then
// the explanation is asked to explain THAT sentence (the rest of the paragraph only as support), the sentence is
// marked on the page, and the card does not mark words of its own. Chosen without a model: the sentence that shares
// the most content words with the rest of the paragraph, relative to its own length, and only when it clearly
// stands out (at least 1.3 times the next one). Short paragraphs (under 3 sentences or 60 words) never qualify, so
// most explanations stay about the whole paragraph.
const MIN_SENTENCES = 3;
const MIN_PARA_WORDS = 60;
const MIN_SENTENCE_WORDS = 8;
const MAX_SENTENCE_CHARS = 400;
const LEAD = 1.3;

export function splitSentences(text) {
  const out = [];
  const re = /[^.!?。！？]+(?:[.!?。！？]+["'”’)\]]*|$)/gu;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const s = m[0].trim();
    if (s) out.push(s);
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return out;
}

export function centralSentence(paragraphText) {
  const sentences = splitSentences(paragraphText);
  if (sentences.length < MIN_SENTENCES || words(paragraphText).length < MIN_PARA_WORDS) return null;
  const sets = sentences.map((s) => new Set(words(s).filter(ok)));
  const scored = sentences.map((s, i) => {
    const n = words(s).length;
    if (n < MIN_SENTENCE_WORDS || s.length > MAX_SENTENCE_CHARS || !sets[i].size) return { s, score: 0 };
    let shared = 0;
    for (const w of sets[i]) if (sets.some((other, j) => j !== i && other.has(w))) shared += 1;
    return { s, score: shared / Math.sqrt(n) };
  }).sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  if (!best || best.score <= 0) return null;
  if (next && next.score > 0 && best.score < LEAD * next.score) return null;
  return best.s;
}

// Marks `sentence` inside `el`, across inline elements if needed (one <mark> per text piece, removed together).
// Pieces inside links and the like are left unmarked. Returns true when something was marked.
export function markSentence(el, sentence, { title = 'The sentence this explanation is about. Click to remove this mark.' } = {}) {
  if (!el || !sentence) return false;
  const doc = el.ownerDocument;
  if (!doc?.createTreeWalker) return false;
  const nodes = [];
  const walker = doc.createTreeWalker(el, 4);
  let full = '';
  let node;
  while ((node = walker.nextNode())) { nodes.push({ node, start: full.length }); full += node.nodeValue; }
  // Whitespace may differ between the page and the text that was read: match with flexible spaces.
  const pattern = new RegExp(sentence.trim().split(/\s+/).map(escapeRe).join('\\s+'), 'u');
  const m = pattern.exec(full);
  if (!m) return false;
  ensureStyle(doc);
  const from = m.index;
  const to = m.index + m[0].length;
  const group = [];
  for (const { node: n, start } of nodes) {
    const end = start + n.nodeValue.length;
    if (end <= from || start >= to) continue;
    if (n.parentElement?.closest(SKIP)) continue;
    let piece = n;
    const a = Math.max(0, from - start);
    const b = Math.min(n.nodeValue.length, to - start);
    if (a > 0) piece = piece.splitText(a);
    if (b - a < piece.nodeValue.length) piece.splitText(b - a);
    if (!piece.nodeValue.trim()) continue;
    const mark = doc.createElement('mark');
    mark.className = `${CLASS} ${CLASS}-sentence`;
    mark.title = title;
    piece.parentNode.insertBefore(mark, piece);
    mark.appendChild(piece);
    group.push(mark);
  }
  if (!group.length) return false;
  const first = group[0];
  first.tabIndex = 0;
  first.setAttribute('aria-label', 'Sentence this explanation is about. Press Enter to remove the mark.');
  const removeAll = (e) => { e.preventDefault(); e.stopPropagation(); for (const g of group) unwrap(g); };
  for (const g of group) {
    g.addEventListener('click', removeAll);
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'Delete') removeAll(e); });
  }
  return true;
}
