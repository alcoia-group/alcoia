// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createUIController, esc, clamp } from '../alcoia/src/content/ui-controller.js';

function build(settings = {}) {
  return createUIController({
    getSettings: () => ({
      highlightEnabled: true, pinDefault: false,
      autohideEnabled: false, autohideTimeoutSec: 12,
      ...settings,
    }),
    fetchSummary: async () => 'a summary',
  });
}

/* Every element createUIController() renders now lives inside its own
 * shadow-host.js shadow root (mode: 'open' — see that file's header), so a
 * plain document.querySelector/getElementById can no longer find any of it.
 * These pierce every [data-alcoia-host] the way a real caller with
 * .shadowRoot access (anything outside the page's own JS) still can. */
function queryAlcoia(selector) {
  for (const host of document.querySelectorAll('[data-alcoia-host]')) {
    const found = host.shadowRoot?.querySelector(selector);
    if (found) return found;
  }
  return null;
}
function queryAllAlcoia(selector) {
  const results = [];
  for (const host of document.querySelectorAll('[data-alcoia-host]')) {
    results.push(...(host.shadowRoot?.querySelectorAll(selector) || []));
  }
  return results;
}

beforeEach(() => {
  document.body.innerHTML = '';
  delete window.__sra_resize_watcher;
  delete window.__sra_self_report_trigger;
});

describe('helpers', () => {
  it('escapes the characters that would break out of an attribute or tag', () => {
    expect(esc('<img src=x onerror="alert(1)">')).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(esc("it's")).toBe('it&#39;s');
  });

  it('coerces non-strings rather than throwing', () => {
    expect(() => esc(null)).not.toThrow();
    expect(esc(42)).toBe('42');
  });

  it('clamps', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
  });
});

describe('reservePopup', () => {
  it('creates a popup and registers it', () => {
    const ui = build();
    const root = ui.reservePopup('abc');
    expect(root).toBeTruthy();
    expect(ui.openPopups.get('abc').el).toBe(root);
    expect(queryAllAlcoia('.sra-popup')).toHaveLength(1);
  });

  it('refuses a duplicate and flashes the card already on screen', () => {
    const ui = build();
    const first = ui.reservePopup('abc');
    first.classList.add('show');
    expect(ui.reservePopup('abc')).toBeNull();
    expect(queryAllAlcoia('.sra-popup')).toHaveLength(1);
  });

  it('replaces a registration whose element has been removed from the page', () => {
    const ui = build();
    const first = ui.reservePopup('abc');
    first.remove();
    const second = ui.reservePopup('abc');
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  /* The behaviour the comprehension renderer was missing before the split:
   * it deduped but never enforced the cap, so a page full of pinned cards
   * could still have another stacked on top of it. */
  it('evicts the oldest unpinned popup at the cap', () => {
    const ui = build();
    for (let i = 0; i < 5; i++) ui.reservePopup(`p${i}`);
    expect(ui.openPopups.size).toBe(5);

    const sixth = ui.reservePopup('p5');
    expect(sixth).toBeTruthy();
    expect(ui.openPopups.size).toBe(5);
    expect(ui.openPopups.has('p0')).toBe(false);   // oldest went
    expect(ui.openPopups.has('p5')).toBe(true);
  });

  it('refuses to add anything when every slot is pinned', () => {
    const ui = build();
    for (let i = 0; i < 5; i++) ui.reservePopup(`p${i}`).dataset.pinned = 'true';
    expect(ui.reservePopup('p5')).toBeNull();
    expect(ui.openPopups.size).toBe(5);
  });
});

/* Step 9A (active intervention awareness) — the intervention policy's one
 * source of truth for "is a question card visible right now". question-
 * card.js tags its own reservePopup() call with kind: 'question'; every
 * other caller in this codebase (self-report, quiz-offer, the plain
 * explain popup) omits it, so this file exercises both halves of that
 * distinction directly against the real openPopups map, plus the multi-
 * card lifecycle (test E) Step 5's concurrency architecture requires. */
describe('hasVisibleQuestionCard (step 9A)', () => {
  it('is false with nothing on screen', () => {
    const ui = build();
    expect(ui.hasVisibleQuestionCard()).toBe(false);
  });

  it('is true once a popup is reserved with kind: "question"', () => {
    const ui = build();
    ui.reservePopup('q-abc', 'question');
    expect(ui.hasVisibleQuestionCard()).toBe(true);
  });

  it('is false for a popup reserved without a kind — the self-report/quiz-offer/plain-explain shape', () => {
    const ui = build();
    ui.reservePopup('abc');
    expect(ui.hasVisibleQuestionCard()).toBe(false);
  });

  it('is false for a popup reserved with a different kind entirely', () => {
    const ui = build();
    ui.reservePopup('abc', 'self-report');
    expect(ui.hasVisibleQuestionCard()).toBe(false);
  });

  it('a mix of a question card and a non-question popup at the same time still reads true', () => {
    const ui = build();
    ui.reservePopup('self-report-card');
    ui.reservePopup('q-abc', 'question');
    expect(ui.hasVisibleQuestionCard()).toBe(true);
  });

  it('becomes false again once the question card is closed', () => {
    const ui = build();
    const root = ui.reservePopup('q-abc', 'question');
    expect(ui.hasVisibleQuestionCard()).toBe(true);
    ui.closePopup(root, 'q-abc');
    expect(ui.hasVisibleQuestionCard()).toBe(false);
  });

  it('(test E) two concurrent question cards: closing one leaves the other still counted as visible; closing both clears it', () => {
    const ui = build();
    const rootA = ui.reservePopup('q-a', 'question');
    const rootB = ui.reservePopup('q-b', 'question');
    expect(ui.hasVisibleQuestionCard()).toBe(true);

    ui.closePopup(rootA, 'q-a');
    expect(ui.hasVisibleQuestionCard()).toBe(true); // B is still up

    ui.closePopup(rootB, 'q-b');
    expect(ui.hasVisibleQuestionCard()).toBe(false); // both gone now
  });

  /* Step 29 (student intervention experience audit): previously, the
   * MAX_POPUPS eviction loop evicted the oldest popup regardless of kind,
   * which meant a live, unanswered retrieval question could be silently
   * closed just because a LATER, unrelated popup needed the slot — with no
   * dismissal ever recorded and the reader's in-progress selection
   * discarded with no trace. reservePopup() now skips past any
   * kind: 'question' entry when looking for something to evict. This test
   * used to fill every slot with question cards and assert the OLDEST one
   * (q-p0) got evicted to make room for a 6th — the exact bug this item
   * fixes. Rewritten to assert the corrected behaviour: with nothing
   * evictable, the 6th reservation is refused outright (the same "every
   * slot is pinned" shape the test right above this one already asserts),
   * and every original question card survives untouched. */
  it('refuses to evict a question card at the MAX_POPUPS cap — a live, unanswered question is never silently closed', () => {
    const ui = build();
    for (let i = 0; i < 5; i++) ui.reservePopup(`q-p${i}`, 'question');
    expect(ui.hasVisibleQuestionCard()).toBe(true);

    const sixth = ui.reservePopup('q-p5', 'question');
    expect(sixth).toBeNull();
    expect(ui.openPopups.has('q-p0')).toBe(true); // nothing evicted
    expect(ui.openPopups.size).toBe(5);
    expect(ui.hasVisibleQuestionCard()).toBe(true);
  });

  it('evicts a non-question popup to make room even while question cards occupy other slots — only question-kind entries are protected', () => {
    const ui = build();
    ui.reservePopup('non-question'); // oldest — no kind
    for (let i = 0; i < 4; i++) ui.reservePopup(`q-p${i}`, 'question');
    expect(ui.openPopups.size).toBe(5);

    const sixth = ui.reservePopup('q-p4', 'question');
    expect(sixth).toBeTruthy();
    expect(ui.openPopups.has('non-question')).toBe(false); // the evictable one went
    expect(ui.openPopups.has('q-p0')).toBe(true); // every question card survived
    expect(ui.openPopups.size).toBe(5);
  });

  it('a pinned question card keeps counting as visible after hidePopup() (Escape) — only an unpinned one is closed by it', () => {
    const ui = build();
    const root = ui.reservePopup('q-abc', 'question');
    root.dataset.pinned = 'true';
    ui.hidePopup();
    expect(ui.hasVisibleQuestionCard()).toBe(true);
  });

  it('an unpinned question card no longer counts as visible after hidePopup() (Escape)', () => {
    const ui = build();
    ui.reservePopup('q-abc', 'question');
    ui.hidePopup();
    expect(ui.hasVisibleQuestionCard()).toBe(false);
  });
});

describe('closePopup', () => {
  it('deregisters immediately and removes the node after the transition', () => {
    vi.useFakeTimers();
    const ui = build();
    const root = ui.reservePopup('abc');
    ui.closePopup(root, 'abc');
    expect(ui.openPopups.has('abc')).toBe(false);
    expect(root.classList.contains('show')).toBe(false);
    vi.advanceTimersByTime(300);
    expect(queryAllAlcoia('.sra-popup')).toHaveLength(0);
    vi.useRealTimers();
  });
});

describe('hidePopup', () => {
  it('closes unpinned popups and leaves pinned ones alone', () => {
    const ui = build();
    ui.reservePopup('a');
    ui.reservePopup('b').dataset.pinned = 'true';
    ui.hidePopup();
    expect(ui.openPopups.has('a')).toBe(false);
    expect(ui.openPopups.has('b')).toBe(true);
  });
});

/* Step 29 (student intervention experience audit). Before this item,
 * resetAutohide() treated a popup reserved with kind: 'question' exactly
 * like any other — a reader who enabled autohide and took longer than its
 * timeout to read the question, pick/type an answer, and go through the
 * separate confidence step had their card silently vanish mid-answer: the
 * selection was discarded, no dismissal was ever recorded, and
 * response-signals.js's own pending record was left dangling forever,
 * resolved as neither an answer nor a dismissal. */
describe('autohide exemption for question cards (Step 29)', () => {
  it('never auto-closes a popup reserved with kind: "question", however long autohide is enabled', () => {
    vi.useFakeTimers();
    try {
      const ui = build({ autohideEnabled: true, autohideTimeoutSec: 3 });
      const root = ui.reservePopup('q-abc', 'question');
      ui.showPopup(root, null);
      vi.advanceTimersByTime(60000);
      expect(ui.openPopups.has('q-abc')).toBe(true);
      expect(root.isConnected).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still auto-closes an ordinary (non-question) popup after its timeout — unaffected by the exemption above', () => {
    vi.useFakeTimers();
    try {
      const ui = build({ autohideEnabled: true, autohideTimeoutSec: 3 });
      const root = ui.reservePopup('abc');
      ui.showPopup(root, null);
      vi.advanceTimersByTime(3500);
      expect(ui.openPopups.has('abc')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a question card exempt from autohide is still closeable by the reader at any time — Escape (hidePopup) is unaffected', () => {
    vi.useFakeTimers();
    try {
      const ui = build({ autohideEnabled: true, autohideTimeoutSec: 3 });
      const root = ui.reservePopup('q-abc', 'question');
      ui.showPopup(root, null);
      ui.hidePopup();
      expect(ui.openPopups.has('q-abc')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-arming autohide on mouseleave also respects the exemption, not just the initial showPopup() call', () => {
    vi.useFakeTimers();
    try {
      const ui = build({ autohideEnabled: true, autohideTimeoutSec: 3 });
      const root = ui.reservePopup('q-abc', 'question');
      ui.showPopup(root, null);
      root.dispatchEvent(new Event('mouseenter'));
      root.dispatchEvent(new Event('mouseleave'));
      vi.advanceTimersByTime(60000);
      expect(ui.openPopups.has('q-abc')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('highlightElement', () => {
  it('respects the highlight setting', () => {
    const el = document.createElement('p');
    document.body.appendChild(el);

    build({ highlightEnabled: false }).highlightElement(el);
    expect(el.classList.contains('sra-para-highlight')).toBe(false);

    build({ highlightEnabled: true }).highlightElement(el);
    expect(el.classList.contains('sra-para-highlight')).toBe(true);
  });

  it('never highlights the whole document', () => {
    const ui = build();
    ui.highlightElement(document.body);
    expect(document.body.classList.contains('sra-para-highlight')).toBe(false);
  });

  it('moves the highlight rather than accumulating them', () => {
    const ui = build();
    const a = document.createElement('p');
    const b = document.createElement('p');
    document.body.append(a, b);
    ui.highlightElement(a);
    ui.highlightElement(b);
    expect(a.classList.contains('sra-para-highlight')).toBe(false);
    expect(b.classList.contains('sra-para-highlight')).toBe(true);
  });
});

describe('renderPopup', () => {
  it('renders nothing without text — there would be no dedup key', () => {
    const ui = build();
    ui.renderPopup(null, '<p>hi</p>', { text: '   ' });
    expect(queryAllAlcoia('.sra-popup')).toHaveLength(0);
  });

  it('escapes the trigger label it puts in the badge', () => {
    const ui = build();
    ui.renderPopup(null, '<div>body</div>', { text: 'some paragraph', trigger: '<script>x</script>' });
    const badge = queryAlcoia('.sra-state-badge');
    expect(badge.innerHTML).not.toContain('<script>');
    expect(badge.textContent).toContain('<script>x</script>');
  });

  it('honours pinDefault', () => {
    const ui = build({ pinDefault: true });
    ui.renderPopup(null, '<div>body</div>', { text: 'some paragraph' });
    expect(queryAlcoia('.sra-popup').dataset.pinned).toBe('true');
  });
});

describe('installResizeWatcher', () => {
  it('installs once even if the content script is injected twice', () => {
    const spy = vi.spyOn(window, 'addEventListener');
    build().installResizeWatcher();
    build().installResizeWatcher();
    const resizeCalls = spy.mock.calls.filter(([type]) => type === 'resize');
    expect(resizeCalls).toHaveLength(1);
    spy.mockRestore();
  });
});

/* Item 13a, affordance 2: a small, persistent, always-clickable trigger —
 * not conditional on any detected state or open card, unlike everything
 * else this module renders. */
describe('ensureSelfReportTrigger', () => {
  it('creates a single clickable trigger element, wired to the given callback', () => {
    const onClick = vi.fn();
    build().ensureSelfReportTrigger(onClick);

    const btn = queryAlcoia('#sra-self-report-trigger');
    expect(btn).toBeTruthy();
    expect(btn.tagName).toBe('BUTTON');

    btn.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('installs once even if called twice (content script injected twice) — the SAME idempotency guard installResizeWatcher already uses', () => {
    const onClick1 = vi.fn();
    const onClick2 = vi.fn();
    build().ensureSelfReportTrigger(onClick1);
    build().ensureSelfReportTrigger(onClick2);

    expect(queryAllAlcoia('#sra-self-report-trigger')).toHaveLength(1);
    // The SECOND call's callback never got wired — the first trigger
    // element (and its original callback) is what actually persists.
    queryAlcoia('#sra-self-report-trigger').click();
    expect(onClick1).toHaveBeenCalledTimes(1);
    expect(onClick2).not.toHaveBeenCalled();
  });

  it('is always present regardless of getSettings() — unlike every other element in this file, it is not conditional on detected state', () => {
    const ui = createUIController({ getSettings: () => ({ highlightEnabled: false, pinDefault: false, autohideEnabled: false }) });
    ui.ensureSelfReportTrigger(() => {});
    expect(queryAlcoia('#sra-self-report-trigger')).toBeTruthy();
  });
});

/* Item DC-2 — the tooltip that offers a math/figure/rare-term explanation.
 * See selection-explain.js for the trigger classification this sits behind;
 * this file only owns rendering it. */
describe('showSelectionTooltip', () => {
  const RECT = { left: 100, top: 100, bottom: 120, right: 200 };

  it('renders a single tooltip with the "Explain this →" action', () => {
    build().showSelectionTooltip(RECT, () => {});
    const el = queryAlcoia('#sra-select-tooltip');
    expect(el).toBeTruthy();
    expect(el.querySelector('.sra-select-tooltip-btn').textContent).toBe('Explain this →');
  });

  it('clicking the action calls the callback and removes the tooltip', () => {
    vi.useFakeTimers();
    try {
      const onExplain = vi.fn();
      build().showSelectionTooltip(RECT, onExplain);
      queryAlcoia('.sra-select-tooltip-btn').click();
      expect(onExplain).toHaveBeenCalledTimes(1);
      // Fade-out delay before actual removal — same shape as closePopup()'s
      // own 250ms — real DOM removal is not synchronous with dismiss().
      vi.advanceTimersByTime(200);
      expect(queryAlcoia('#sra-select-tooltip')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a click anywhere else on the page dismisses it without calling the callback', () => {
    vi.useFakeTimers();
    try {
      const onExplain = vi.fn();
      build().showSelectionTooltip(RECT, onExplain);
      expect(queryAlcoia('#sra-select-tooltip')).toBeTruthy();

      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      vi.advanceTimersByTime(200);
      expect(queryAlcoia('#sra-select-tooltip')).toBeNull();
      expect(onExplain).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a second call replaces any tooltip already on screen — at most one at a time', () => {
    build().showSelectionTooltip(RECT, () => {});
    build().showSelectionTooltip(RECT, () => {});
    expect(queryAllAlcoia('#sra-select-tooltip')).toHaveLength(1);
  });

  it('does nothing when given no anchor rect, rather than rendering an unpositioned tooltip', () => {
    build().showSelectionTooltip(null, () => {});
    expect(queryAlcoia('#sra-select-tooltip')).toBeNull();
  });

  it('auto-dismisses after its own timeout if the reader does neither', () => {
    vi.useFakeTimers();
    try {
      build().showSelectionTooltip(RECT, () => {});
      expect(queryAlcoia('#sra-select-tooltip')).toBeTruthy();
      vi.advanceTimersByTime(8000);
      // The removal itself is on a short follow-up setTimeout after the
      // class-removal transition — advance past that too.
      vi.advanceTimersByTime(200);
      expect(queryAlcoia('#sra-select-tooltip')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
