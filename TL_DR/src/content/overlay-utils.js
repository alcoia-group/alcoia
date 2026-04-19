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

const BLOCK_TAGS = new Set([
  'P','LI','TD','TH','BLOCKQUOTE','DD','DT',
  'ARTICLE','SECTION','MAIN','ASIDE','FIGURE',
  'H1','H2','H3','H4','H5','H6',
]);

const MIN_TEXT = 60; // chars — ignore elements with less text than this

export function getBlockAncestor(el) {
  if (!el) return null;
  let node = el;

  // Walk up looking for a semantic block tag first
  while (node && node !== document.body && node !== document.documentElement) {
    if (BLOCK_TAGS.has(node.nodeName)) {
      const text = (node.innerText || node.textContent || '').trim();
      if (text.length >= MIN_TEXT) return node;
    }
    node = node.parentElement;
  }

  // Fallback: any block-display element with enough text
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
  // Legacy — kept for any remaining callers. New code uses clampToViewport in content.js.
  if (!root || !document.body.contains(root)) document.body.appendChild(root);
  root.style.display = 'block';
  root.style.position = 'fixed';
  const pw = root.offsetWidth  || 360;
  const ph = root.offsetHeight || 160;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const m  = 14;
  const x  = options.x || vw / 2;
  const y  = options.y || vh / 2;
  root.style.left = Math.max(m, Math.min(x + 12, vw - pw - m)) + 'px';
  root.style.top  = Math.max(m, Math.min(y,      vh - ph - m)) + 'px';
  requestAnimationFrame(() => root.classList.add('show'));
}
