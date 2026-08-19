/* sidebar.js — the panel the toolbar's hamburger opens (item 39, problem 3).
 *
 * Native shows a thumbnail strip always, and a second "document outline"
 * tab only when the PDF actually has one (getOutline() returns entries) —
 * confirmed against a real screenshot of Chromium's own viewer while
 * building this, not assumed. Matched here: the tab switcher itself is
 * only built when there is a second tab to switch to.
 */
import { ICONS } from './icons.js';

export function createSidebar({ pdfDoc, container, onJumpToPage, getCurrentPage }) {
  let outline = null; // null = not checked yet, [] = checked, none found
  let activeTab = 'thumbnails';
  let thumbCanvases = new Map(); // page number -> canvas

  container.innerHTML = `
    <div class="pdf-sidebar-tabs" hidden>
      <button type="button" class="pdf-sidebar-tab active" data-tab="thumbnails" title="Page thumbnails">${ICONS.thumbnails}</button>
      <button type="button" class="pdf-sidebar-tab" data-tab="outline" title="Document outline">${ICONS.outlineTab}</button>
    </div>
    <div class="pdf-sidebar-body" data-panel="thumbnails"></div>
  `;
  const body = container.querySelector('.pdf-sidebar-body');
  const tabsRow = container.querySelector('.pdf-sidebar-tabs');

  async function buildThumbnails() {
    body.innerHTML = '';
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'pdf-thumb';
      cell.dataset.page = i;
      const canvas = document.createElement('canvas');
      cell.appendChild(canvas);
      const label = document.createElement('span');
      label.textContent = i;
      cell.appendChild(label);
      cell.addEventListener('click', () => onJumpToPage(i));
      body.appendChild(cell);
      thumbCanvases.set(i, canvas);
      renderThumb(i).catch(() => {});
    }
    highlightCurrent();
  }

  async function renderThumb(num) {
    const canvas = thumbCanvases.get(num);
    if (!canvas) return;
    const page = await pdfDoc.getPage(num);
    const unscaled = page.getViewport({ scale: 1 });
    const targetWidth = 108;
    const scale = targetWidth / unscaled.width;
    const vp = page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2); // thumbnails do not need the full backing-store cap treatment — they are tiny
    canvas.width  = Math.round(vp.width * dpr);
    canvas.height = Math.round(vp.height * dpr);
    canvas.style.width  = vp.width + 'px';
    canvas.style.height = vp.height + 'px';
    const ctx = canvas.getContext('2d');
    const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined;
    await page.render({ canvasContext: ctx, viewport: vp, transform }).promise;
  }

  function highlightCurrent() {
    const cur = getCurrentPage();
    body.querySelectorAll('.pdf-thumb').forEach((el) => {
      el.classList.toggle('current', Number(el.dataset.page) === cur);
    });
  }

  async function resolveDest(dest) {
    try {
      const explicit = typeof dest === 'string' ? await pdfDoc.getDestination(dest) : dest;
      if (!explicit) return null;
      const pageIndex = await pdfDoc.getPageIndex(explicit[0]);
      return pageIndex + 1;
    } catch (e) { return null; }
  }

  function renderOutlineItems(items, list) {
    items.forEach((item) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = '#';
      a.className = 'pdf-outline-item';
      a.textContent = item.title || '(untitled)';
      a.addEventListener('click', async (e) => {
        e.preventDefault();
        const page = await resolveDest(item.dest);
        if (page) onJumpToPage(page);
      });
      li.appendChild(a);
      if (item.items?.length) {
        const sub = document.createElement('ul');
        renderOutlineItems(item.items, sub);
        li.appendChild(sub);
      }
      list.appendChild(li);
    });
  }

  async function buildOutline() {
    if (outline === null) {
      try { outline = (await pdfDoc.getOutline()) || []; } catch (e) { outline = []; }
      if (outline.length) {
        tabsRow.hidden = false;
      }
    }
    body.innerHTML = '';
    if (!outline.length) {
      const empty = document.createElement('div');
      empty.className = 'pdf-sidebar-empty';
      empty.textContent = 'This document has no outline.';
      body.appendChild(empty);
      return;
    }
    const list = document.createElement('ul');
    list.className = 'pdf-outline-list';
    renderOutlineItems(outline, list);
    body.appendChild(list);
  }

  tabsRow.addEventListener('click', (e) => {
    const btn = e.target.closest('.pdf-sidebar-tab');
    if (!btn) return;
    activeTab = btn.dataset.tab;
    tabsRow.querySelectorAll('.pdf-sidebar-tab').forEach((b) => b.classList.toggle('active', b === btn));
    if (activeTab === 'thumbnails') buildThumbnails(); else buildOutline();
  });

  // Checked once, eagerly, so the tab row appears (or stays hidden) before
  // the reader ever opens the sidebar — matching native, where the tab
  // switcher's presence does not itself require opening the panel first.
  buildOutline().then(() => { if (activeTab === 'thumbnails') buildThumbnails(); });

  return {
    onPageChanged() { if (activeTab === 'thumbnails') highlightCurrent(); },
    async rebuildThumbnails() {
      if (activeTab === 'thumbnails') await buildThumbnails();
      else thumbCanvases.forEach((_, num) => renderThumb(num).catch(() => {}));
    },
  };
}
