/* pdf-highlights.js — colour highlights for alcoia's own PDF viewer (item
 * 39, problem 2).
 *
 * content.js highlights an ordinary HTML page by wrapping a Range in a
 * <mark> via range.surroundContents() (content.js:~572, ~726). That is
 * architecturally wrong for a pdf.js text layer: the layer is a set of
 * absolutely positioned spans, one per text run, each with its own
 * transform and baseline — wrapping each run individually produces one
 * styled box per run (with padding and border-radius on every fragment),
 * the broken-patchwork look this item exists to fix. No CSS fix is
 * possible because the geometry, not the styling, is wrong. This file is a
 * DELIBERATELY SEPARATE implementation for exactly that reason — it does
 * not touch, import from, or share code with content.js's DOM-page
 * highlighting, which already works correctly there and is left alone.
 *
 * The fix: never style a text-layer span. A highlight is drawn as its own
 * absolutely positioned overlay layer, behind the text layer and above the
 * canvas, built from range.getClientRects() (real line-level rectangles)
 * rather than the range's DOM structure. The overlay never receives
 * pointer events, so text selection keeps working straight through it —
 * which is also why removal cannot be a dblclick on the highlighted text
 * itself (a dblclick there has to reach the text layer's own spans, the
 * same as anywhere else on the page); removal is a small hover-revealed
 * chip instead, the same discoverable-affordance shape item 40 already
 * established for the DOM path, adapted here because this page has no
 * content.js of its own to reuse it from (chrome-extension:// pages never
 * receive a content script — see reading-bridge.js's own header).
 *
 * Persistence reuses the existing sra_text_highlights store and entry shape
 * unchanged, keyed under `pdf:<sourceUrl>` rather than a hostname+pathname —
 * the same key shape reading-bridge.js's documentKey() already uses for
 * this exact "one coverage/quiz record per distinct PDF, not per viewer
 * URL" reason. This is why a PDF highlight already shows up on the
 * standalone Highlights page and the in-page sidebar with zero changes to
 * either: both only ever cared about the entry shape, never the source.
 */
import { HIGHLIGHT_COLOR_MAP, HIGHLIGHT_ANCHOR_PARAM } from '../shared/highlights-render.js';

const MIN_SELECTION_CHARS = 3; // shorter minimum than the DOM path's 15 — a PDF selection is often one heading or a short label

export function createPdfHighlights({ sourceUrl, title, viewerContainer }) {
  const urlKey = `pdf:${sourceUrl}`;
  let byId = new Map(); // id -> { id, text, color, colorKey, page, timestamp }
  let chipEl = null;
  let chipHideAt = null;

  function overlayFor(wrap) {
    let ov = wrap.querySelector(':scope > .hl-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.className = 'hl-overlay';
      // Painted after the canvas but the text layer is appended after this
      // in renderPage(), so DOM order alone already puts it in between —
      // pointer-events:none (not z-index) is what keeps it from ever
      // intercepting a click or a selection drag.
      const canvas = wrap.querySelector('canvas');
      canvas.insertAdjacentElement('afterend', ov);
    }
    return ov;
  }

  // ── Rect geometry ─────────────────────────────────────────────────────
  // getClientRects() returns one rect per contiguous inline run the range
  // touches — several per visual line wherever a run boundary falls (a
  // font/transform change, or simply where pdf.js split two adjacent
  // spans). This groups them back into lines and draws one clean bar per
  // line, wrap-relative so the bars survive scroll without adjustment.
  function rectsForRange(range, wrap) {
    const wrapRect = wrap.getBoundingClientRect();
    const raw = Array.from(range.getClientRects())
      .filter((r) => r.width > 0.5 && r.height > 0.5)
      .map((r) => ({
        left: r.left - wrapRect.left, top: r.top - wrapRect.top,
        right: r.right - wrapRect.left, bottom: r.bottom - wrapRect.top,
      }));
    if (!raw.length) return [];

    raw.sort((a, b) => a.top - b.top || a.left - b.left);
    const heights = raw.map((r) => r.bottom - r.top).sort((a, b) => a - b);
    const tolerance = Math.max(2, heights[Math.floor(heights.length / 2)] * 0.4);

    const lines = [];
    for (const r of raw) {
      let line = lines.find((l) => Math.abs(l.top - r.top) < tolerance);
      if (!line) { line = { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; lines.push(line); }
      line.top    = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
      line.left   = Math.min(line.left, r.left);
      line.right  = Math.max(line.right, r.right);
    }
    // Snap every line to the same height (the tallest run in that line) so
    // mixed-size runs on one visual line still draw as a single even bar.
    return lines.map((l) => ({ left: l.left, top: l.top, width: l.right - l.left, height: l.bottom - l.top }));
  }

  function drawRects(id, rects, colorKey, wrap) {
    const ov = overlayFor(wrap);
    const group = document.createElement('div');
    group.className = 'hl-group';
    group.dataset.hlId = id;
    rects.forEach((r) => {
      const bar = document.createElement('div');
      bar.className = 'hl-bar';
      bar.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;background:${HIGHLIGHT_COLOR_MAP[colorKey] || '#FFF59D'};`;
      group.appendChild(bar);
    });
    ov.appendChild(group);
  }

  // ── Create ───────────────────────────────────────────────────────────
  function createFromRange(range, colorKey) {
    const text = range.toString().trim();
    if (!text || text.length < MIN_SELECTION_CHARS || text.length > 2000) return null;
    const wrap = range.startContainer.nodeType === Node.TEXT_NODE
      ? range.startContainer.parentElement.closest('.page-wrap')
      : range.startContainer.closest?.('.page-wrap');
    if (!wrap) return null;
    const page = Number(wrap.dataset.page);
    const rects = rectsForRange(range, wrap);
    if (!rects.length) return null;

    const id = 'sra-pdf-hl-' + Date.now();
    drawRects(id, rects, colorKey, wrap);
    const entry = {
      id, text: text.slice(0, 300), color: HIGHLIGHT_COLOR_MAP[colorKey], colorKey, page,
      url: sourceUrl, title: title || sourceUrl, timestamp: Date.now(),
    };
    byId.set(id, entry);
    persist();
    return entry;
  }

  // ── Restore ──────────────────────────────────────────────────────────
  // Locates the stored text within the ONE page it was made on (a PDF page
  // is already a natural search boundary, unlike a DOM highlight's
  // whole-document ambiguity) and draws it. Silent no-op if the text is not
  // found on that page — the same abstain-rather-than-guess rule
  // content.js's restoreSingleHighlight() already uses; a page whose text
  // extraction genuinely differs run to run is not expected, but nothing
  // here assumes it cannot happen.
  function restoreOnPage(pageNum, wrap) {
    const forThisPage = [...byId.values()].filter((e) => e.page === pageNum);
    if (!forThisPage.length) return;
    const textLayer = wrap.querySelector('.textLayer');
    if (!textLayer) return;

    const spans = Array.from(textLayer.querySelectorAll('span')).filter((s) => s.firstChild);
    let full = '';
    const spanRanges = []; // { span, start, end } offsets into `full`
    for (const sp of spans) {
      const t = sp.textContent || '';
      spanRanges.push({ span: sp, start: full.length, end: full.length + t.length });
      full += t;
    }

    for (const entry of forThisPage) {
      const idx = full.indexOf(entry.text.length <= 300 ? entry.text : entry.text.slice(0, 300));
      if (idx === -1) continue; // gone from this render — abstain, entry stays in storage for a future match
      const matchEnd = idx + Math.min(entry.text.length, 300);
      const startSpan = spanRanges.find((s) => idx >= s.start && idx < s.end);
      const endSpan = spanRanges.find((s) => matchEnd > s.start && matchEnd <= s.end) || spanRanges[spanRanges.length - 1];
      if (!startSpan || !endSpan) continue;
      try {
        const range = document.createRange();
        range.setStart(startSpan.span.firstChild, idx - startSpan.start);
        range.setEnd(endSpan.span.firstChild, matchEnd - endSpan.start);
        const rects = rectsForRange(range, wrap);
        if (rects.length) drawRects(entry.id, rects, entry.colorKey, wrap);
      } catch (e) { /* malformed offset — abstain rather than mis-highlight */ }
    }
  }

  // ── Remove ───────────────────────────────────────────────────────────
  function remove(id) {
    hideChip();
    document.querySelectorAll(`.hl-group[data-hl-id="${CSS.escape(id)}"]`).forEach((g) => g.remove());
    byId.delete(id);
    persist();
  }

  function removeAllForDocument() {
    document.querySelectorAll('.hl-overlay').forEach((ov) => { ov.innerHTML = ''; });
    byId.clear();
    persist();
  }

  // ── Hover-revealed remove chip ───────────────────────────────────────
  // The overlay itself is pointer-events:none (selection has to reach the
  // text layer underneath it), so there is no click target ON a highlight
  // to dblclick. Instead, mousemove over the page hit-tests the stored
  // rects directly and reveals a small floating chip near whichever
  // highlight the pointer is over — same shape as the DOM path's hover
  // chip (content.js), a separate small element rather than a control laid
  // over the highlighted text itself.
  function wireRemovalAffordance(rootEl) {
    rootEl.addEventListener('mousemove', (e) => {
      const wrap = e.target.closest?.('.page-wrap');
      if (!wrap) { scheduleHideChip(); return; }
      const wrapRect = wrap.getBoundingClientRect();
      const x = e.clientX - wrapRect.left, y = e.clientY - wrapRect.top;
      const hitGroup = Array.from(wrap.querySelectorAll('.hl-group')).find((g) =>
        Array.from(g.children).some((bar) => {
          const l = parseFloat(bar.style.left), t = parseFloat(bar.style.top);
          const w = parseFloat(bar.style.width), h = parseFloat(bar.style.height);
          return x >= l && x <= l + w && y >= t && y <= t + h;
        }));
      if (hitGroup) showChip(hitGroup.dataset.hlId, e.clientX, e.clientY);
      else scheduleHideChip();
    });
    rootEl.addEventListener('scroll', hideChip, { passive: true, capture: true });
  }

  function showChip(id, clientX, clientY) {
    clearTimeout(chipHideAt);
    if (chipEl && chipEl.dataset.hlId === id) return;
    hideChip();
    const chip = document.createElement('div');
    chip.className = 'hl-chip';
    chip.dataset.hlId = id;
    chip.style.left = Math.min(clientX + 8, window.innerWidth - 150) + 'px';
    chip.style.top  = Math.max(clientY - 34, 4) + 'px';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Remove highlight';
    btn.addEventListener('click', () => remove(id));
    chip.appendChild(btn);
    chip.addEventListener('mouseenter', () => clearTimeout(chipHideAt));
    chip.addEventListener('mouseleave', scheduleHideChip);
    document.body.appendChild(chip);
    chipEl = chip;
  }
  function scheduleHideChip() {
    clearTimeout(chipHideAt);
    chipHideAt = setTimeout(hideChip, 220);
  }
  function hideChip() {
    clearTimeout(chipHideAt);
    if (chipEl) { chipEl.remove(); chipEl = null; }
  }

  // ── Storage ──────────────────────────────────────────────────────────
  function persist() {
    chrome.storage.local.get({ sra_text_highlights: {} }, ({ sra_text_highlights: hl }) => {
      hl[urlKey] = [...byId.values()];
      if (!hl[urlKey].length) delete hl[urlKey];
      chrome.storage.local.set({ sra_text_highlights: hl });
    });
  }

  async function load() {
    const hl = await new Promise((r) => chrome.storage.local.get({ sra_text_highlights: {} }, (res) => r(res.sra_text_highlights)));
    byId = new Map((hl[urlKey] || []).map((e) => [e.id, e]));
  }

  // Jump-to-exact-spot support, matching content.js's scrollToRequestedHighlight —
  // the Highlights page/sidebar link a PDF highlight's card to this viewer
  // with ?sra_hl=<id>appended to its own ?src=... URL.
  function requestedHighlightId() {
    try { return new URL(location.href).searchParams.get(HIGHLIGHT_ANCHOR_PARAM); } catch (e) { return null; }
  }
  function pageForRequestedHighlight() {
    const id = requestedHighlightId();
    if (!id) return null;
    return byId.get(id)?.page ?? null;
  }
  function flashIfRequested(pageNum, wrap) {
    const id = requestedHighlightId();
    if (!id) return;
    const entry = byId.get(id);
    if (!entry || entry.page !== pageNum) return;
    const group = wrap.querySelector(`.hl-group[data-hl-id="${CSS.escape(id)}"]`);
    if (!group) return;
    // Reuses overlay.css's existing nudge-pulse animation (already loaded by
    // viewer.html) rather than defining a second one — same arrival cue the
    // DOM path's scrollToRequestedHighlight() uses.
    // .hl-group has no intrinsic size of its own (only its absolutely
    // positioned .hl-bar children do) — scroll the first bar, which does.
    (group.firstElementChild || wrap).scrollIntoView({ behavior: 'smooth', block: 'center' });
    group.classList.add('sra-nudge-highlight');
    setTimeout(() => group.classList.remove('sra-nudge-highlight'), 3000);
  }

  // ── Creation gesture ─────────────────────────────────────────────────
  // Same Ctrl+drag → colour-picker interaction content.js already uses on
  // ordinary pages, reimplemented here rather than imported — the two
  // pickers are visually and behaviourally identical by design, but this
  // page has no content.js to call into (see header).
  let pickerEl = null;
  function removeColorPicker() { pickerEl?.remove(); pickerEl = null; }

  function showColorPicker(range, clientX, clientY) {
    removeColorPicker();
    const picker = document.createElement('div');
    picker.id = 'pdf-hl-color-picker';
    Object.assign(picker.style, {
      position: 'fixed', zIndex: '2147483001',
      left: Math.min(clientX, window.innerWidth - 200) + 'px',
      top: (clientY + 10) + 'px',
      background: 'white', border: '1px solid rgba(0,0,0,0.10)', borderRadius: '14px',
      padding: '8px 11px', display: 'flex', alignItems: 'center', gap: '7px',
      boxShadow: '0 6px 24px rgba(0,0,0,0.16)', fontFamily: 'system-ui, sans-serif',
    });
    Object.entries(HIGHLIGHT_COLOR_MAP).forEach(([key, bg]) => {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.title = key;
      Object.assign(sw.style, {
        width: '22px', height: '22px', borderRadius: '50%', background: bg,
        border: '2px solid rgba(0,0,0,0.12)', cursor: 'pointer', flexShrink: '0',
      });
      sw.addEventListener('mousedown', (e) => e.preventDefault()); // keep selection alive
      sw.addEventListener('click', (e) => {
        e.stopPropagation();
        createFromRange(range, key);
        removeColorPicker();
      });
      picker.appendChild(sw);
    });
    document.body.appendChild(picker);
    setTimeout(() => document.addEventListener('click', removeColorPicker, { once: true }), 10);
  }

  function wireCreation(rootEl) {
    rootEl.addEventListener('mouseup', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      const sel = window.getSelection();
      const text = sel?.toString().trim() || '';
      if (text.length < MIN_SELECTION_CHARS || !sel.rangeCount) return;
      const range = sel.getRangeAt(0).cloneRange();
      showColorPicker(range, e.clientX, e.clientY);
    });
  }

  wireRemovalAffordance(viewerContainer);
  wireCreation(viewerContainer);

  return {
    load,
    createFromRange,
    restoreOnPage,
    removeAllForDocument,
    pageForRequestedHighlight,
    flashIfRequested,
    count: () => byId.size,
  };
}
