/* Word and sentence counting across scripts.
 *
 * The bug these pin: every word count in the pipeline was `split(/\s+/)`, so a
 * paragraph of Chinese, Japanese, Thai, Khmer, Lao or Burmese counted as one
 * word and fell under every downstream threshold. Nothing threw. The extension
 * simply produced no signal on those pages, which is the hardest kind of
 * failure to notice — the same shape as the unstyled question card and the
 * deleted keyboard handler.
 */
import { describe, it, expect } from 'vitest';
import {
  countWords, splitSentences, countClauseMarks, isSpaceDelimited,
  structureIsUnreadable, detectLanguage,
} from '../alcoia/src/content/telemetry/segmentation.js';
import { analyzeDifficulty, syntacticLoad } from '../alcoia/src/content/telemetry/text-difficulty.js';
import { createParagraphTracker } from '../alcoia/src/content/telemetry/paragraph-tracker.js';

const ZH = '人工智能正在改变世界的运作方式。许多研究人员认为，这项技术将在未来十年内彻底重塑经济结构。然而，也有人担心它带来的风险远远超过收益。';
const JA = '読書は人間の思考を形づくる重要な行為である。文章を目で追うだけでは理解したことにならない。実際に内容を思い出せるかどうかが、理解の唯一の証拠である。';
const TH = 'การอ่านหนังสือเป็นสิ่งสำคัญสำหรับการพัฒนาความคิด ผู้อ่านที่ดีจะสามารถจดจำเนื้อหาได้ดีกว่าผู้ที่อ่านผ่านๆ';
const AR = 'القراءة الجيدة تتطلب انتباها مستمرا ولا تكفي حركة العين وحدها لإثبات الفهم؟ كثير من القراء يعتقدون أنهم فهموا النص بينما لم يستوعبوا منه شيئا يذكر';
const EN = 'The measurement of reading comprehension has a long history. It began with the assumption that eye movement is a proxy for attention. That assumption is largely wrong.';

describe('countWords', () => {
  it('counts English the same as a whitespace split', () => {
    expect(countWords(EN, 'en')).toBe(EN.split(/\s+/).length);
  });

  it('returns a real count for Chinese instead of 1', () => {
    const naive = ZH.split(/\s+/).length;
    expect(naive).toBe(1);                 // the bug, pinned
    expect(countWords(ZH, 'zh')).toBeGreaterThan(20);
  });

  it('returns a real count for Japanese instead of 1', () => {
    expect(JA.split(/\s+/).length).toBe(1);
    expect(countWords(JA, 'ja')).toBeGreaterThan(20);
  });

  it('returns a real count for Thai', () => {
    expect(countWords(TH, 'th')).toBeGreaterThan(8);
  });

  it('counts Arabic, which is space-delimited', () => {
    expect(countWords(AR, 'ar')).toBeGreaterThan(15);
  });

  it('is empty for empty input', () => {
    expect(countWords('', 'en')).toBe(0);
    expect(countWords(null, 'zh')).toBe(0);
  });

  it('knows which scripts have no inter-word space', () => {
    expect(isSpaceDelimited('en')).toBe(true);
    expect(isSpaceDelimited('ar')).toBe(true);
    expect(isSpaceDelimited('zh')).toBe(false);
    expect(isSpaceDelimited('ja')).toBe(false);
    expect(isSpaceDelimited('th')).toBe(false);
  });
});

describe('splitSentences', () => {
  it('splits English on terminal punctuation', () => {
    expect(splitSentences(EN, 'en').length).toBe(3);
  });

  it('splits Chinese on the ideographic full stop', () => {
    expect(splitSentences(ZH, 'zh').length).toBeGreaterThanOrEqual(3);
  });

  it('sees the Arabic question mark, which the old regex did not', () => {
    // The old splitter was /[.!?。！？]+/ — no ؟ — so this whole passage was
    // one sentence and scored as maximally dense prose.
    expect(splitSentences(AR, 'ar').length).toBeGreaterThanOrEqual(2);
  });

  it('counts clause marks including the ideographic and Arabic commas', () => {
    expect(countClauseMarks('a, b; c')).toBe(2);
    expect(countClauseMarks('甲、乙，丙')).toBe(2);
    expect(countClauseMarks('واحد، اثنان؛ ثلاثة')).toBe(2);
  });
});

describe('structure availability', () => {
  it('reports structure unavailable rather than maximally dense', () => {
    expect(structureIsUnreadable(['one long run'], 200)).toBe(true);
    expect(structureIsUnreadable(['a', 'b'], 200)).toBe(false);
    expect(structureIsUnreadable(['short'], 10)).toBe(false);
  });

  it('does not score a Thai paragraph as very_difficult on structure alone', () => {
    const long = TH.repeat(4);
    const r = analyzeDifficulty(long, { lang: 'th' });
    expect(r.wordCount).toBeGreaterThan(30);
    expect(r.grade).not.toBe('very_difficult');
  });
});

describe('analyzeDifficulty across languages', () => {
  it('produces a usable word count for Chinese', () => {
    const r = analyzeDifficulty(ZH, { lang: 'zh' });
    expect(r.wordCount).toBeGreaterThan(20);
    expect(r.basis).toBe('syntactic');
    expect(['easy', 'standard', 'difficult', 'very_difficult']).toContain(r.grade);
  });

  it('does not run Flesch-Kincaid on non-English text', () => {
    const r = analyzeDifficulty(ZH, { lang: 'zh' });
    expect(r.fleschScore).toBeUndefined();
  });

  it('still runs Flesch-Kincaid on English', () => {
    const r = analyzeDifficulty(EN, { lang: 'en' });
    expect(r.basis).toBe('flesch_kincaid+syntactic');
    expect(typeof r.fleschScore).toBe('number');
  });

  it('honours the legacy isEnglish option', () => {
    expect(analyzeDifficulty(EN, { isEnglish: false }).basis).not.toContain('flesch');
  });

  it('does not push Arabic to very_difficult by default', () => {
    // The English anchors (7 words/clause, 15 words/sentence) applied to Arabic
    // scored ordinary prose as dense, and skimming only interrupts on dense
    // text — so this was a systematic over-interruption of Arabic readers.
    const r = analyzeDifficulty(AR, { lang: 'ar' });
    expect(r.grade).not.toBe('very_difficult');
  });

  it('uses per-language structural anchors', () => {
    const text = 'واحد اثنان ثلاثة أربعة خمسة ستة سبعة ثمانية تسعة عشرة أحد عشر اثنا عشر ثلاثة عشر أربعة عشر خمسة عشر ستة عشر سبعة عشر ثمانية عشر تسعة عشر عشرون.';
    const asArabic = syntacticLoad(text, 'ar').score;
    const asDefault = syntacticLoad(text, 'sv').score;
    expect(asArabic).toBeGreaterThan(asDefault);   // higher score = judged easier
  });
});

describe('detectLanguage', () => {
  const fakeDoc = (lang, text) => ({
    documentElement: { lang },
    querySelector: () => null,
    body: { innerText: text || '' },
  });

  it('prefers the document tag', () => {
    expect(detectLanguage(fakeDoc('fr-CA', ''))).toBe('fr');
  });

  it('sniffs the script when there is no tag', () => {
    expect(detectLanguage(fakeDoc('', ZH.repeat(3)))).toBe('zh');
    expect(detectLanguage(fakeDoc('', JA.repeat(3)))).toBe('ja');
    expect(detectLanguage(fakeDoc('', AR.repeat(3)))).toBe('ar');
  });

  it('does not fall back to the browser language', () => {
    // A French page with no tag on an en-US browser used to be read as English,
    // which then ran a syllable counter that deletes é, è and ç.
    const fr = 'La lecture attentive exige un effort soutenu et une réelle présence à soi.';
    expect(detectLanguage(fakeDoc('', fr.repeat(6)))).toBe('en'); // latin script, no tag
    expect(detectLanguage(fakeDoc('fr', fr))).toBe('fr');
  });
});

describe('paragraph tracker word threshold', () => {
  /* The threshold is where the CJK failure actually bit: `minWords: 20` against
     a count of 1 meant no paragraph on a Chinese page was ever a candidate. */
  function trackerWith(text, lang) {
    const el = {
      innerText: text,
      getBoundingClientRect: () => ({ top: 100, bottom: 400, left: 0, right: 800, height: 300, width: 800 }),
    };
    const doc = { querySelectorAll: () => [el] };
    return createParagraphTracker({
      document: doc,
      lang: () => lang,
      axis: () => ({ vertical: false, rtl: false }),
      viewportHeight: () => 800,
      viewportWidth: () => 1200,
      minWords: 20,
    });
  }

  it('accepts a Chinese paragraph', () => {
    const t = trackerWith(ZH, 'zh');
    t.rescan();
    expect(t.count()).toBe(1);
  });

  it('accepts a Japanese paragraph', () => {
    const t = trackerWith(JA, 'ja');
    t.rescan();
    expect(t.count()).toBe(1);
  });

  it('still rejects a genuinely short paragraph', () => {
    const t = trackerWith('太短了。', 'zh');
    t.rescan();
    expect(t.count()).toBe(0);
  });

  it('tracks a vertical-writing page on the horizontal axis', () => {
    const el = {
      innerText: JA,
      getBoundingClientRect: () => ({ top: 0, bottom: 800, left: 700, right: 1000, height: 800, width: 300 }),
    };
    const doc = { querySelectorAll: () => [el] };
    const t = createParagraphTracker({
      document: doc,
      lang: () => 'ja',
      axis: () => ({ vertical: true, rtl: true }),
      viewportHeight: () => 800,
      viewportWidth: () => 1200,
      minWords: 20,
    });
    t.rescan();
    // Reading line for vertical-rl sits at 0.6 * 1200 = 720, inside [700,1000].
    const transition = t.update();
    expect(transition).not.toBeNull();
    expect(transition.entered).not.toBeNull();
  });
});
