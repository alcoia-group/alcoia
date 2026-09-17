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
