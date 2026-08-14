/* segmentation.js — counting words and sentences in scripts that do not mark
 * their boundaries the way English does.
 *
 * Everything upstream of this file counted words with `text.split(/\s+/)`.
 * Chinese, Japanese, Thai, Khmer, Lao and Burmese do not put spaces between
 * words, so a 600-character Chinese paragraph counted as one word. Both word
 * thresholds in the pipeline then rejected it — `minWords: 20` in
 * paragraph-tracker and `MIN_WORD_COUNT: 70` in comprehension-monitor — so on
 * those pages no paragraph was ever tracked, no difficulty computed, no pace
 * measured and no signal emitted. The extension loaded, ran, and did nothing,
 * silently, on a large fraction of the web.
 *
 * `Intl.Segmenter` is the right primitive and is native in Chrome 87+ and
 * Safari 14.1+, so it costs no dependency and covers every target this
 * product has. Segmenter instances are expensive to build, so they are cached
 * per locale.
 *
 * What this file does not claim: that a segmented "word" in Chinese is
 * commensurable with an English word. It is not. What matters downstream is
 * that the count scales with the amount of text, so a reader's own baseline
 * and their own residual distribution can calibrate the rest — which is
 * exactly how the pace signals already work for English.
 */

const HAS_SEGMENTER = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';

const WORD_SEGMENTERS = new Map();
const SENT_SEGMENTERS = new Map();

/* Scripts with no inter-word space. */
const NO_SPACE_LANGS = /^(zh|ja|th|km|lo|my|bo|dz)/i;
/* Scripts written right to left. */
const RTL_LANGS = /^(ar|he|fa|ur|ps|yi|ug|sd|dv|ku|ckb)/i;

/* Terminal punctuation by script family. The original splitter was
 * `/[.!?。！？]+/`, which has no Arabic question mark (؟ U+061F), no Urdu full
 * stop (۔ U+06D4) and no Devanagari danda (। U+0964). Arabic prose frequently
 * contains no ASCII period at all, so a whole paragraph collapsed into one
 * "sentence", words-per-sentence exploded, and it scored very_difficult almost
 * every time — which, because skimming only interrupts on difficult text,
 * meant systematically over-interrupting Arabic readers. */
const SENTENCE_RE = /[.!?。！？؟۔।॥៕။၊…]+/;

/* Marks that usually introduce a clause, used for the clause-count proxy.
 * Includes the ideographic and fullwidth commas and the Arabic comma and
 * semicolon, none of which were counted before. */
const CLAUSE_RE = /[,;:—–、，；：،؛।]/g;

/* Fallback ratios for when Intl.Segmenter is missing. Deliberately crude —
 * they exist so an old engine degrades to a rough count instead of to 1. */
const CHARS_PER_WORD = { zh: 1.7, ja: 2.0, th: 5.0, km: 5.5, lo: 5.0, my: 4.5, bo: 4.0 };

/* Segmenting a whole book on every scroll tick is not worth it; paragraphs are
 * far below this. */
const MAX_SEGMENT_CHARS = 20000;

export function isSpaceDelimited(lang) { return !NO_SPACE_LANGS.test(lang || ''); }
export function isRTL(lang) { return RTL_LANGS.test(lang || ''); }

function primary(lang) { return String(lang || '').toLowerCase().slice(0, 2) || 'en'; }

function wordSegmenter(lang) {
  const key = primary(lang);
  if (!WORD_SEGMENTERS.has(key)) {
    try { WORD_SEGMENTERS.set(key, new Intl.Segmenter(key, { granularity: 'word' })); }
    catch (e) { WORD_SEGMENTERS.set(key, null); }
  }
  return WORD_SEGMENTERS.get(key);
}

function sentenceSegmenter(lang) {
  const key = primary(lang);
  if (!SENT_SEGMENTERS.has(key)) {
    try { SENT_SEGMENTERS.set(key, new Intl.Segmenter(key, { granularity: 'sentence' })); }
    catch (e) { SENT_SEGMENTERS.set(key, null); }
  }
  return SENT_SEGMENTERS.get(key);
}

/* Word-like segments. `isWordLike` is what excludes punctuation and spacing,
 * so the count is comparable to what a whitespace split gives for English. */
export function segmentWords(text, lang) {
  const t = String(text || '').slice(0, MAX_SEGMENT_CHARS).replace(/\s+/g, ' ').trim();
  if (!t) return [];

  if (HAS_SEGMENTER) {
    const seg = wordSegmenter(lang);
    if (seg) {
      const out = [];
      for (const s of seg.segment(t)) if (s.isWordLike) out.push(s.segment);
      return out;
    }
  }

  if (isSpaceDelimited(lang)) return t.split(/\s+/).filter((w) => w.length > 0);

  // No segmenter and no spaces: estimate from character count.
  const ratio = CHARS_PER_WORD[primary(lang)] || 2.0;
  const chars = t.replace(/\s+/g, '').length;
  return new Array(Math.max(1, Math.round(chars / ratio))).fill('');
}

export function countWords(text, lang) {
  return segmentWords(text, lang).length;
}

/* Source formatting must not become sentence structure. `Intl.Segmenter` at
 * sentence granularity treats a hard newline as a boundary, and `textContent`
 * on a paragraph carries whatever line wrapping the HTML author used — so a
 * single dense sentence broken across five source lines was being read as five
 * sentences and scored as ordinary prose. Collapsing runs of whitespace to one
 * space fixes it without destroying Thai, where the space is a phrase break
 * rather than a word break. */
const normalise = (t) => t.replace(/\s+/g, ' ').trim();

export function splitSentences(text, lang) {
  const t = normalise(String(text || '').slice(0, MAX_SEGMENT_CHARS));
  if (!t) return [];

  if (HAS_SEGMENTER) {
    const seg = sentenceSegmenter(lang);
    if (seg) {
      const out = [];
      for (const s of seg.segment(t)) {
        const v = s.segment.trim();
        if (v) out.push(v);
      }
      if (out.length) return out;
    }
  }
  return t.split(SENTENCE_RE).map((s) => s.trim()).filter((s) => s.length > 0);
}

export function countClauseMarks(text) {
  return (String(text || '').match(CLAUSE_RE) || []).length;
}

/* True when the text gave up no sentence structure at all — one "sentence"
 * covering a long paragraph. Thai marks phrase breaks with spaces and has no
 * terminal punctuation, so this is its normal state rather than a failure.
 * Callers should report structure as unavailable instead of scoring the
 * paragraph as maximally dense, which is what the old code did. */
export function structureIsUnreadable(sentences, wordCount) {
  return sentences.length <= 1 && wordCount > 60;
}

/* The content language, from the document rather than the browser.
 *
 * The previous check fell back to `navigator.language`, so a French page with
 * no lang attribute, read on an en-US browser, was treated as English — and
 * Flesch-Kincaid then ran over it with a syllable counter that strips
 * everything outside [a-z], deleting é, è and ç and scoring the text far
 * easier than it is. Sniffing the text is worse than an explicit tag and
 * better than asking the browser what its menus are in. */
const SCRIPT_PROBES = [
  [/[一-鿿]/g, 'zh'],   // CJK unified — also used by ja, resolved below
  [/[぀-ゟ]/g, 'ja'],   // hiragana is decisive for Japanese
  [/[゠-ヿ]/g, 'ja'],
  [/[가-힯]/g, 'ko'],
  [/[฀-๿]/g, 'th'],
  [/[؀-ۿ]/g, 'ar'],
  [/[֐-׿]/g, 'he'],
  [/[ऀ-ॿ]/g, 'hi'],
  [/[Ѐ-ӿ]/g, 'ru'],
  [/[ក-៿]/g, 'km'],
  [/[຀-໿]/g, 'lo'],
  [/[က-႟]/g, 'my'],
];

let langCache = { at: 0, doc: null, lang: 'en' };

export function detectLanguage(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d) return 'en';

  /* The untagged branch reads body.innerText, which is not free, and this is
     now called from paragraph entry, recall candidacy and selection handling.
     Keyed on document identity so tests passing distinct fakes are unaffected. */
  const t = Date.now();
  if (langCache.doc === d && t - langCache.at < 5000) return langCache.lang;

  const tagged = (
    d.documentElement?.lang
    || d.querySelector?.('meta[http-equiv="content-language"]')?.content
    || ''
  ).trim();
  if (tagged) {
    langCache = { at: t, doc: d, lang: primary(tagged) };
    return langCache.lang;
  }

  const sample = (d.body?.innerText || '').replace(/\s+/g, '').slice(0, 1500);
  if (sample.length < 40) return 'en';

  let best = null;
  let bestShare = 0;
  for (const [re, code] of SCRIPT_PROBES) {
    const n = (sample.match(re) || []).length;
    const share = n / sample.length;
    if (share > bestShare) { bestShare = share; best = code; }
  }
  // Hiragana or katakana anywhere in quantity means Japanese, not Chinese.
  if (best === 'zh' && /[぀-ヿ]/.test(sample)) best = 'ja';
  langCache = { at: t, doc: d, lang: bestShare > 0.15 ? best : 'en' };
  return langCache.lang;
}

/* Vertical Japanese and Chinese (writing-mode: vertical-rl) turn the reading
 * line from a horizontal band into a vertical one. Rare on the web, but when
 * it happens every position heuristic here points the wrong way. */
export function readingAxis(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d || typeof getComputedStyle !== 'function') return { vertical: false, rtl: false };
  let mode = '';
  let dir = '';
  try {
    const cs = getComputedStyle(d.body || d.documentElement);
    mode = cs.writingMode || '';
    dir = cs.direction || '';
  } catch (e) { /* detached document */ }
  return {
    vertical: /^vertical/.test(mode) || /^sideways/.test(mode),
    rtl: dir === 'rtl' || /-rl$/.test(mode),
  };
}
