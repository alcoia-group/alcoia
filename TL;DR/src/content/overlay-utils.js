/* overlay-utils.js
   Responsibilities:
   - Place floating popup elements near target rect or client coords
   - Avoid overlapping selection ranges
   - Flip popup to available sides and clamp to viewport
   - Provide helpers: getBlockAncestor, hidePopup
*/

function getPopupSize(root) {
  const prev = root.style.display;
  const prevVis = root.style.visibility;
  root.style.display = 'block'; root.style.visibility = 'hidden';
  const rect = root.getBoundingClientRect();
  root.style.display = prev; root.style.visibility = prevVis;
  return { width: rect.width, height: rect.height };
}

export function getBlockAncestor(el) {
  while (el && el !== document.body) {
    const display = window.getComputedStyle(el).display;
    if (/^(block|list-item|table|flex|grid)$/.test(display)) return el;
    el = el.parentElement;
  }
  return null;
}

export function hidePopup(root) {
  if (!root) root = document.getElementById('sra-floating-popup');
  if (!root) return;
  // Respect pinned state: don't hide if pinned
  if (root.dataset && root.dataset.pinned === 'true') return;
  root.classList.remove('show'); setTimeout(()=>{ if (root) root.style.display='none'; }, 220);
}

export function placePopup(root, options = {}) {
  // options: { x, y, rect (client rect), avoidSelection (bool) }
  const x = options.x; const y = options.y; const rect = options.rect;
  // compute selection bounding rect if needed
  let selRect = null;
  if (options.avoidSelection) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0).getBoundingClientRect(); if (r && (r.width||r.height)) selRect = r;
    }
  }
  // ensure root in DOM
  if (!root || !document.body.contains(root)) { document.body.appendChild(root); }
  const size = getPopupSize(root);
  // candidate positions (right, left, bottom, top)
  let target = rect || { left: x, top: y, right: x + 8, bottom: y + 8 };
  const padding = 8;
  const spaceRight = window.innerWidth - target.right - padding;
  const spaceLeft = target.left - padding;
  const spaceTop = target.top - padding;
  const spaceBottom = window.innerHeight - target.bottom - padding;
  let px = target.right + padding, py = target.top;
  // choose best side
  if (spaceRight >= size.width) { px = target.right + padding; py = target.top; }
  else if (spaceLeft >= size.width) { px = Math.max(padding, target.left - padding - size.width); py = target.top; }
  else if (spaceBottom >= size.height) { px = target.left; py = target.bottom + padding; }
  else { px = Math.max(padding, window.innerWidth - size.width - padding); py = Math.max(padding, target.top - size.height - padding); }
  // avoid selection overlap by shifting vertically if possible
  if (selRect) {
    const overlapX = !(px + size.width < selRect.left || px > selRect.right);
    const overlapY = !(py + size.height < selRect.top || py > selRect.bottom);
    if (overlapX && overlapY) {
      // try move above selection
      if (selRect.top - padding - size.height > padding) py = selRect.top - padding - size.height;
      else if (selRect.bottom + padding + size.height < window.innerHeight) py = selRect.bottom + padding;
      else py = Math.max(padding, window.innerHeight - size.height - padding);
    }
  }
  // clamp
  px = Math.max(8, Math.min(px, window.innerWidth - size.width - 8));
  py = Math.max(8, Math.min(py, window.innerHeight - size.height - 8));
  root.style.left = px + 'px'; root.style.top = py + 'px'; root.style.display = 'block';
  requestAnimationFrame(()=> root.classList.add('show'));
}
