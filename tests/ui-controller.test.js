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

beforeEach(() => {
  document.body.innerHTML = '';
  delete window.__sra_resize_watcher;
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
    expect(document.querySelectorAll('.sra-popup')).toHaveLength(1);
  });

  it('refuses a duplicate and flashes the card already on screen', () => {
    const ui = build();
    const first = ui.reservePopup('abc');
    first.classList.add('show');
    expect(ui.reservePopup('abc')).toBeNull();
    expect(document.querySelectorAll('.sra-popup')).toHaveLength(1);
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
    expect(document.querySelectorAll('.sra-popup')).toHaveLength(0);
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
    expect(document.querySelectorAll('.sra-popup')).toHaveLength(0);
  });

  it('escapes the trigger label it puts in the badge', () => {
    const ui = build();
    ui.renderPopup(null, '<div>body</div>', { text: 'some paragraph', trigger: '<script>x</script>' });
    const badge = document.querySelector('.sra-state-badge');
    expect(badge.innerHTML).not.toContain('<script>');
    expect(badge.textContent).toContain('<script>x</script>');
  });

  it('honours pinDefault', () => {
    const ui = build({ pinDefault: true });
    ui.renderPopup(null, '<div>body</div>', { text: 'some paragraph' });
    expect(document.querySelector('.sra-popup').dataset.pinned).toBe('true');
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
