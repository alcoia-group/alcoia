/* ui-controller.js — everything the reader actually sees
 *
 * Extracted from content.js, which was a single 1982-line IIFE. This owns the
 * popup lifecycle (creation, positioning, dedup, the MAX_POPUPS cap, pinning,
 * autohide), the paragraph highlight, the toasts and the dark-mode stylesheet.
 *
 * It owns `openPopups`. Nothing outside this module should mutate that map —
 * the eviction cap and the dedup-by-fingerprint logic both depend on it being
 * the single record of what is on screen.
 *
 * Settings are read through a getter rather than captured, because the storage
 * listener in content.js reassigns them at runtime and a captured copy would
 * silently go stale.
 */

const POPUP_MARGIN = 14;
const MAX_POPUPS   = 5;      // hard cap before the oldest unpinned is evicted

export const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function createUIController(deps = {}) {
  const getSettings = deps.getSettings || (() => ({}));
  const fetchSummary = deps.fetchSummary || (async () => '');
  const margin = deps.popupMargin ?? POPUP_MARGIN;
  const maxPopups = deps.maxPopups ?? MAX_POPUPS;

  /* fingerprint -> { el }. The single record of what is on screen. */
  const openPopups = new Map();
  let lastHighlighted = null;

  // ── Paragraph highlight ──────────────────────────────────────────────────
  function highlightElement(el, ms = 5000) {
    if (!getSettings().highlightEnabled) return;
    if (!el || el === document.body || el === document.documentElement) return;
    clearHighlight();
    el.classList.add('sra-para-highlight');
    lastHighlighted = el;
    setTimeout(clearHighlight, ms);
  }

  function clearHighlight() {
    if (lastHighlighted) {
      lastHighlighted.classList.remove('sra-para-highlight');
      lastHighlighted = null;
    }
  }

  /* Below this the viewport has no margin to speak of, so a floating card
     always covers text. Phones get a bottom sheet instead. */
  const NARROW_VIEWPORT = 560;
  /* A card narrower than this stops being readable, so it is not worth
     squeezing into a margin below it. */
  const MIN_CARD_W = 262;

  // ── Positioning ──────────────────────────────────────────────────────────
  function placePopup(root, anchorRect, avoidRects) {
    root.style.visibility = 'hidden';
    root.style.display    = 'block';

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const m  = margin;

    /* Phone-sized viewport: pin to the bottom, full width. Trying to dodge
       the text on a 390px screen just means covering different text. A sheet
       at the bottom is the one position that is predictable, reachable with
       a thumb, and never lands on the line being read. */
    if (vw < NARROW_VIEWPORT) {
      root.classList.add('sra-sheet');
      root.style.left = root.style.right = '10px';
      root.style.width = 'auto';
      root.style.maxWidth = 'none';
      root.style.position = 'fixed';
      const sh = root.offsetHeight || 200;
      root.style.top = Math.max(m, vh - sh - 12) + 'px';
      root.style.visibility = '';
      return;
    }
    root.classList.remove('sra-sheet');
    root.style.right = '';
    root.style.width = '';
    root.style.maxWidth = '';

    const pw = root.offsetWidth  || 360;
    const ph = root.offsetHeight || 150;
    const a  = anchorRect || { left: vw/2-100, right: vw/2+100, top: vh/2-30, bottom: vh/2+30 };
    const av = avoidRects || [];

    function overlaps(cx, cy) {
      return av.some((r) =>
        cx < r.right + m && cx + pw > r.left - m &&
        cy < r.bottom + m && cy + ph > r.top - m
      );
    }

    // Shift a candidate down past any blocking popup, up to 6 attempts
    function settle(left, top) {
      for (let i = 0; i < 6; i++) {
        if (!overlaps(left, top)) return { left, top };
        const blocker = av.find((r) =>
          left < r.right + m && left + pw > r.left - m &&
          top  < r.bottom + m && top  + ph > r.top - m
        );
        if (!blocker || blocker.bottom + m + ph > vh - m) return null;
        top = blocker.bottom + m;
      }
      return null;
    }

    const candidates = [];
    if (a.right  + m + pw <= vw - m) candidates.push({ left: a.right + m,     top: clamp(a.top, m, vh - ph - m) });
    if (a.left   - m - pw >= m)      candidates.push({ left: a.left - m - pw, top: clamp(a.top, m, vh - ph - m) });
    if (a.bottom + m + ph <= vh - m) candidates.push({ left: clamp(a.left, m, vw - pw - m), top: a.bottom + m });
    if (a.top    - m - ph >= m)      candidates.push({ left: clamp(a.left, m, vw - pw - m), top: a.top - m - ph });

    let chosen = null;
    for (const c of candidates) {
      chosen = settle(c.left, c.top);
      if (chosen) break;
    }

    /* Nothing fits beside the passage at full width. Before giving up and
       dropping the card on top of the text — which is what the old last
       resort did, so on a wide-column page the question covered the very
       paragraph it was asking about — try narrowing into whichever margin is
       larger. A slightly narrow card the reader can read around beats a
       comfortable one sitting on the words. */
    if (!chosen) {
      const leftGap  = a.left - m * 2;
      const rightGap = vw - a.right - m * 2;
      const useRight = rightGap >= leftGap;
      const gap = useRight ? rightGap : leftGap;

      if (gap >= MIN_CARD_W) {
        const w = Math.min(pw, gap);
        root.style.width    = w + 'px';
        root.style.maxWidth = w + 'px';
        const nh = root.offsetHeight || ph;
        root.style.left = (useRight ? a.right + m : a.left - m - w) + 'px';
        root.style.top  = clamp(a.top, m, Math.max(m, vh - nh - m)) + 'px';
        root.style.position   = 'fixed';
        root.style.visibility = '';
        return;
      }
      chosen = { left: vw - pw - m, top: m };
    }

    root.style.left       = clamp(chosen.left, m, vw - pw - m) + 'px';
    root.style.top        = clamp(chosen.top,  m, vh - ph - m) + 'px';
    root.style.position   = 'fixed';
    root.style.visibility = '';
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────
  function closePopup(el, fingerprint) {
    if (fingerprint) openPopups.delete(fingerprint);
    clearTimeout(el._hideT);
    el.classList.remove('show');
    setTimeout(() => { try { el.remove(); } catch (e) {} }, 250);
  }

  function flashPopup(el) {
    const orig = el.style.boxShadow;
    el.style.transition = 'box-shadow 0.12s';
    el.style.boxShadow  = '0 0 0 3px rgba(126,96,174,0.65)';
    setTimeout(() => { el.style.boxShadow = orig; }, 500);
  }

  /* Close all unpinned popups (Esc). */
  function hidePopup() {
    for (const [fp, { el }] of [...openPopups.entries()]) {
      if (!el || !document.contains(el)) { openPopups.delete(fp); continue; }
      if (el.dataset.pinned !== 'true') closePopup(el, fp);
    }
  }

  /* Reserve a slot for a popup keyed on `fingerprint`.
   *
   * Returns the root element, or null when the caller should not proceed:
   * either an identical popup is already visible (it gets flashed instead) or
   * every slot is taken by a pinned popup. Both branches used to be duplicated
   * in each caller, and the comprehension renderer had drifted — it did the
   * dedup check but not the cap. */
  function reservePopup(fingerprint) {
    if (openPopups.has(fingerprint)) {
      const entry = openPopups.get(fingerprint);
      if (entry.el && document.contains(entry.el)) { flashPopup(entry.el); return null; }
      openPopups.delete(fingerprint);
    }

    if (openPopups.size >= maxPopups) {
      for (const [fp, { el }] of openPopups.entries()) {
        if (!el || !document.contains(el)) { openPopups.delete(fp); break; }
        if (el.dataset.pinned !== 'true') { closePopup(el, fp); break; }
      }
      // Every open popup is pinned and we are at the cap — do not add another.
      if (openPopups.size >= maxPopups) return null;
    }

    const root = document.createElement('div');
    root.className = 'sra-popup';
    root.addEventListener('mouseenter', () => { root._mouseOver = true; clearTimeout(root._hideT); });
    root.addEventListener('mouseleave', () => { root._mouseOver = false; resetAutohide(root, fingerprint); });
    document.body.appendChild(root);
    openPopups.set(fingerprint, { el: root });
    return root;
  }

  /* Show, place and start the autohide countdown. */
  function showPopup(root, anchorRect) {
    const avoidRects = [...openPopups.values()]
      .filter((e) => e.el !== root && document.contains(e.el) && e.el.classList.contains('show'))
      .map((e) => e.el.getBoundingClientRect());

    placePopup(root, anchorRect, avoidRects);
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('show')));
    resetAutohide(root);
  }

  /* (Re)arm the autohide countdown. It runs only when autohide is on, the card
   * is not pinned, and the reader is not currently hovering it. Hiding a card
   * someone is still reading is the most irritating thing this UI can do. */
  function resetAutohide(root, fingerprint) {
    const { autohideEnabled, autohideTimeoutSec } = getSettings();
    clearTimeout(root._hideT);
    if (!autohideEnabled || root.dataset.pinned === 'true') return;
    if (root._mouseOver) return;
    const fp = fingerprint || findFingerprint(root);
    root._hideT = setTimeout(() => closePopup(root, fp), Math.max(3, autohideTimeoutSec || 12) * 1000);
  }

  function findFingerprint(root) {
    for (const [fp, { el }] of openPopups.entries()) if (el === root) return fp;
    return null;
  }

  // ── The standard summary card ────────────────────────────────────────────
  function renderPopup(anchorRect, html, meta = {}) {
    // No text → no dedup key and no meaningful content.
    if (!meta.text || !meta.text.trim()) return;

    const fingerprint = meta.text.slice(0, 80).trim();
    const root = reservePopup(fingerprint);
    if (!root) return;

    const badge = meta.trigger
      ? `<div class="sra-state-badge">${esc(meta.triggerLabel || meta.trigger)}</div>`
      : meta.source === 'selection'
        ? '<div class="sra-state-badge">selected text</div>'
        : '';

    root.innerHTML = `
      <div class="sra-controls">
        <button class="sra-ctrl-btn sra-pin-btn" title="Pin">📌</button>
        <button class="sra-ctrl-btn sra-close-btn" title="Close">✕</button>
      </div>
      <div class="sra-popup-body" dir="auto">${badge}${html}</div>
      <div class="sra-popup-divider"></div>
      <div class="sra-actions">
        <button class="sra-btn sra-btn-primary  sra-explain-btn">Explain More</button>
        <button class="sra-btn sra-btn-secondary sra-note-btn">Save Note</button>
      </div>`;

    root.querySelector('.sra-close-btn').onclick = () => closePopup(root, fingerprint);

    const pinBtn = root.querySelector('.sra-pin-btn');
    if (getSettings().pinDefault) { root.dataset.pinned = 'true'; pinBtn.classList.add('active'); }
    pinBtn.onclick = () => {
      const pinned = root.dataset.pinned !== 'true';
      root.dataset.pinned = pinned.toString();
      pinBtn.classList.toggle('active', pinned);
      clearTimeout(root._hideT);
      if (!pinned) {
        // Unpin always starts a countdown — the autohide time when enabled, else
        // a generous 60s so forgotten cards do not accumulate forever.
        const { autohideEnabled, autohideTimeoutSec } = getSettings();
        const secs = autohideEnabled ? Math.max(3, autohideTimeoutSec || 12) : 60;
        root._hideT = setTimeout(() => closePopup(root, fingerprint), secs * 1000);
      }
    };

    root.querySelector('.sra-explain-btn').onclick = async () => {
      const btn = root.querySelector('.sra-explain-btn');
      btn.disabled = true; btn.textContent = 'Thinking…';
      const s = await fetchSummary(meta.text || '', 'explain_more');
      const body = root.querySelector('.sra-popup-body');
      if (body && s) body.innerHTML = badge + `<div>${esc(s)}</div>`;
      btn.textContent = 'Explain More'; btn.disabled = false;
      // Give the reader time to read the expanded content.
      resetAutohide(root, fingerprint);
    };

    root.querySelector('.sra-note-btn').onclick = () => {
      chrome.runtime.sendMessage({ action: 'saveNote', note: { text: meta.text || '', meta } });
      const btn = root.querySelector('.sra-note-btn');
      btn.textContent = 'Saved ✓'; btn.disabled = true;
    };

    showPopup(root, anchorRect);
  }

  // ── Nudge and toasts ─────────────────────────────────────────────────────
  function showNudge(el) {
    if (!el) return;
    el.classList.add('sra-nudge');
    setTimeout(() => el.classList.remove('sra-nudge'), 2200);
  }

  function toast(id, text, styles, ms) {
    document.getElementById(id)?.remove();
    const node = document.createElement('div');
    node.id = id;
    Object.assign(node.style, styles);
    node.textContent = text;
    document.body.appendChild(node);
    requestAnimationFrame(() => requestAnimationFrame(() => { node.style.opacity = '1'; }));
    setTimeout(() => {
      node.style.opacity = '0';
      setTimeout(() => { try { node.remove(); } catch (e) {} }, 250);
    }, ms);
  }

  /* Test-only. The labels are the engine's state names, not the classifier's
   * older ones — a toast reading "Confused" would put a word back in front of
   * the reader that this product deliberately stopped claiming to measure. */
  function showSimulateToast(state) {
    const labels = {
      struggling: 'Simulating: struggling  (Alt+1)',
      drifting:   'Simulating: drifting    (Alt+3)',
      skimming:   'Simulating: skimming    (Alt+4)',
      on_pace:    'Simulating: on pace     (Alt+5)',
    };
    toast('sra-sim-toast', labels[state] || `Simulating: ${state}`, {
      position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
      background: '#5F4589', color: 'white', padding: '9px 18px', borderRadius: '10px',
      fontFamily: 'var(--alc-ui, system-ui, sans-serif)', fontSize: '12px', fontWeight: '600',
      zIndex: '2147483646', opacity: '0', transition: 'opacity 0.2s ease',
      pointerEvents: 'none', whiteSpace: 'pre', boxShadow: '0 6px 20px rgba(60,48,32,0.28)',
    }, 1800);
  }

  /* Re-clamp visible popups when the viewport changes, so a resize cannot
   * strand a card off-screen. Guarded against double installation because the
   * content script can be injected more than once into the same page. */
  function installResizeWatcher() {
    if (window.__sra_resize_watcher) return;
    window.__sra_resize_watcher = true;
    let timer;
    window.addEventListener('resize', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const m  = margin;
        for (const [, { el }] of openPopups.entries()) {
          if (!el || !document.contains(el) || !el.classList.contains('show')) continue;
          const pw = el.offsetWidth  || 360;
          const ph = el.offsetHeight || 150;
          el.style.left = clamp(parseFloat(el.style.left) || 0, m, vw - pw - m) + 'px';
          el.style.top  = clamp(parseFloat(el.style.top)  || 0, m, vh - ph - m) + 'px';
        }
      }, 150);
    });
  }

  return {
    openPopups,
    installResizeWatcher,
    highlightElement, clearHighlight,
    placePopup, closePopup, flashPopup, hidePopup,
    reservePopup, showPopup, resetAutohide,
    renderPopup,
    showNudge, showSimulateToast,
  };
}

// ── Dark mode (in-page overlays) ───────────────────────────────────────────
/* Overlay.css draws everything from the --alc-* tokens, so dark mode is
 * mostly a token swap on the host page's :root — twenty lines of !important
 * overrides per component used to be needed and are not any more. The rules
 * that remain are for surfaces styled inline by their own modules (the
 * reading map, the colour picker), which cannot see the tokens. */
export function applyDarkMode(enabled) {
  const ID = 'sra-dark-styles';
  if (!enabled) { document.getElementById(ID)?.remove(); return; }
  if (document.getElementById(ID)) return;
  const s = document.createElement('style');
  s.id = ID;
  s.textContent = `
      :root {
        --alc-paper:     #171B19 !important;
        --alc-surface:   rgba(23,27,25,0.97) !important;
        --alc-border:    rgba(160,200,180,0.13) !important;
        --alc-border-2:  rgba(183,159,224,0.30) !important;
        --alc-text:      #E6E3DB !important;
        --alc-muted:     #9A958B !important;
        --alc-faint:     #767066 !important;
        --alc-accent:    #B79FE0 !important;
        --alc-accent-2:  #CDBBEE !important;
        --alc-accent-sf: rgba(183,159,224,0.12) !important;
        --alc-warn:      #D9A94E !important;
        --alc-shadow:
          0 0 0 1px rgba(160,200,180,0.13),
          0 12px 32px -8px rgba(0,0,0,0.6) !important;
      }
      .sra-btn-primary { color: #10221B !important; }
      .sra-q-option    { background: rgba(255,255,255,0.045) !important; }
      .sra-word-bubble { background: rgba(14,17,15,0.96) !important; }
      #sra-reading-map { background: rgba(18,22,20,0.97) !important; border-color: rgba(126,96,174,0.12) !important; }
      .sra-map-header  { color: #6B6862 !important; border-color: rgba(126,96,174,0.1) !important; }
      .sra-map-heading { color: #b8b8b2 !important; }
      .sra-map-heading:hover   { background: rgba(126,96,174,0.07) !important; }
      .sra-map-heading.current { color: #C3ABE8 !important; border-left-color: #C3ABE8 !important; }
      .sra-map-event       { color: #888 !important; }
      .sra-map-events-label{ color: #555 !important; }
      .sra-map-divider     { background: rgba(126,96,174,0.1) !important; }
      .sra-map-progress-bar{ background: rgba(126,96,174,0.12) !important; }
      #sra-color-picker { background: #1e2422 !important; border-color: rgba(255,255,255,0.08) !important; }
    `;
  document.head.appendChild(s);
}
