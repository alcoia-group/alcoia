/* overlay-utils.js
   Responsibilities:
   - Place floating popup elements near target rect or client coords
   - Avoid overlapping selection ranges
   - Flip popup to available sides and clamp to viewport
   - Provide helpers: getBlockAncestor, hidePopup
*/

/* overlay-utils.js
   getBlockAncestor: climbs the DOM to find a meaningful paragraph-level block.
   Strategy: prefer <p>, <li>, <td>, <blockquote>, <article>, <section>, 
   then any block-display element, but never return body/html.
   Minimum text length enforced so we don't summarise a one-word heading.
*/

/* overlay-utils.js — v2
   Improved getBlockAncestor:
   - Checks semantic HTML tags
   - Checks ARIA roles (catches most React/Vue SPAs)
   - Detects canvas elements and returns null with a flag
   - Pierces open shadow roots one level deep
   - Minimum text length enforced
*/

const BLOCK_TAGS = new Set([
  'P','LI','TD','TH','BLOCKQUOTE','DD','DT',
  'ARTICLE','SECTION','MAIN','ASIDE','FIGURE',
  'H1','H2','H3','H4','H5','H6',
]);

const BLOCK_ROLES = new Set([
  'article','main','complementary','contentinfo',
  'region','note','definition','paragraph',
]);

const MIN_TEXT = 60;

export function getBlockAncestor(el) {
  if (!el) return null;

  // ── Canvas detection ──────────────────────────────────────────────────────
  // Canvas content is pixels, not DOM — we cannot extract text.
  // Return a special sentinel object so the caller can show a specific message.
  if (el.nodeName === 'CANVAS') return null;

  // Check if any ancestor is a canvas (element is inside canvas overlay)
  let check = el.parentElement;
  while (check && check !== document.body) {
    if (check.nodeName === 'CANVAS') return null;
    check = check.parentElement;
  }

  // ── Shadow DOM piercing (open shadow roots only) ──────────────────────────
  if (el.shadowRoot) {
    // el is a shadow host — try to find the real element inside
    try {
      const rect    = el.getBoundingClientRect();
      const cx      = rect.left + rect.width  / 2;
      const cy      = rect.top  + rect.height / 2;
      const inner   = el.shadowRoot.elementFromPoint(cx, cy);
      if (inner && inner !== el) return getBlockAncestor(inner);
    } catch (e) {}
  }

  // ── iframe detection ──────────────────────────────────────────────────────
  if (el.nodeName === 'IFRAME') {
    try {
      const doc = el.contentDocument;
      if (doc) {
        const rect = el.getBoundingClientRect();
        const cx   = rect.left + rect.width  / 2;
        const cy   = rect.top  + rect.height / 2;
        const inner = doc.elementFromPoint(cx - rect.left, cy - rect.top);
        if (inner) return getBlockAncestor(inner);
      }
    } catch (e) {
      // Cross-origin iframe — cannot pierce
      return null;
    }
  }

  // ── Standard block tag / ARIA role search ─────────────────────────────────
  let node = el;
  while (node && node !== document.body && node !== document.documentElement) {
    const tag  = node.nodeName;
    const role = node.getAttribute ? (node.getAttribute('role') || '') : '';

    if (BLOCK_TAGS.has(tag) || BLOCK_ROLES.has(role)) {
      const text = (node.innerText || node.textContent || '').trim();
      if (text.length >= MIN_TEXT) return node;
    }
    node = node.parentElement;
  }

  // ── Fallback: computed display style ─────────────────────────────────────
  node = el;
  while (node && node !== document.body && node !== document.documentElement) {
    try {
      const display = window.getComputedStyle(node).display;
      if (/^(block|list-item|table-cell|flex|grid)$/.test(display)) {
        const text = (node.innerText || node.textContent || '').trim();
        if (text.length >= MIN_TEXT) return node;
      }
    } catch (e) {}
    node = node.parentElement;
  }

  return null;
}

export function hidePopup(root) {
  if (!root) root = document.getElementById('sra-floating-popup');
  if (!root) return;
  if (root.dataset && root.dataset.pinned === 'true') return;
  root.classList.remove('show');
  setTimeout(() => { if (root) root.style.display = 'none'; }, 220);
}

export function placePopup(root, options = {}) {
  if (!root || !document.body.contains(root)) document.body.appendChild(root);
  root.style.display  = 'block';
  root.style.position = 'fixed';
  const pw = root.offsetWidth  || 360;
  const ph = root.offsetHeight || 160;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const m  = 14;
  const x  = options.x || vw / 2;
  const y  = options.y || vh / 2;
  root.style.left = Math.max(m, Math.min(x + 12, vw - pw - m)) + 'px';
  root.style.top  = Math.max(m, Math.min(y,       vh - ph - m)) + 'px';
  requestAnimationFrame(() => root.classList.add('show'));
}