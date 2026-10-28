/* why-this.js — the one plain reason a card may give for appearing, as a key into the why.* strings in i18n.js.
 *
 * Every automatic card (a question, an explanation, a repair, a scheduled review, a transfer check, a quick check, a check
 * after an absence, an instructor's focus) can say why it showed up; a card the reader asked for says what they asked for.
 * The reason is built only from what the card already knows about itself: the evidence lines the policy attached, and the
 * card's kind. It states what happened ("you took longer on this paragraph"), never a score, a label for the reader, or a
 * claim about why they struggled. No detector is named. A kind or evidence the table does not know gives no reason, so the
 * card shows no "Why" line rather than a wrong one. Built in the browser; nothing here is sent anywhere. */

const SLOW = /slower|longer|paused|uneven/i;
const BACK = /scrolled back|went back|jumped straight back|re-?read|review/i;
const TOLD = /you said|you reported|you told/i;

export function whyFor(kind, { evidence = [], tier = null, focus = false } = {}) {
  const lines = Array.isArray(evidence) ? evidence.filter((e) => typeof e === 'string') : [];
  const has = (re) => lines.some((l) => re.test(l));
  switch (kind) {
    case 'ask':
      if (has(TOLD)) return { key: 'why.hard', auto: true };
      if (has(BACK)) return { key: 'why.reread', auto: true };
      if (has(SLOW)) return { key: 'why.slow', auto: true };
      return { key: 'why.hard', auto: true };
    case 'explain':
      return { key: 'why.explain', auto: true };
    case 'repair':
      return { key: 'why.repair', auto: true };
    case 'retention':
      return focus ? { key: 'why.focus', auto: true } : { key: 'why.review', auto: true };
    case 'transfer':
      return { key: 'why.transfer', auto: true };
    case 'probe':
      return { key: 'why.probe', auto: true };
    case 'return_check':
      return { key: 'why.return', auto: true };
    case 'session_recall':
      return { key: 'why.recall', auto: false };
    default:
      return null;
  }
}
