/* viewer.js — the local-PDF viewer's rendering logic, external for MV3.
 *
 * This used to be an inline <script> in viewer.html. MV3's default
 * extension-page CSP is `script-src 'self'`, which blocks inline scripts
 * outright with no exception carved out here — so the inline version never
 * ran at all. Chromium logged the CSP refusal to the console, not as a page
 * error, so `window.status` sat on "Loading PDF…" forever with nothing
 * throwing (see CLAUDE.md, "the suite's failure mode is absence, not
 * error" — the same shape, just outside the test suite this time). Moving
 * the identical code to this external file is the fix: same logic, allowed
 * to execute.
 *
 * Item 39 rewrote this file's rendering (device-pixel-aware, render.js),
 * highlighting (an overlay layer, pdf-highlights.js) and chrome (icon
 * toolbar + thumbnail/outline sidebar, native layout) for parity with
 * Chrome's own PDF viewer. See render.js and pdf-highlights.js for the two
 * correctness fixes' own detailed reasoning; this file is the orchestrator.
 */
import { attachReadingBridge } from './reading-bridge.js';
import { renderPage, watchDevicePixelRatio } from './render.js';
import { createPdfHighlights } from './pdf-highlights.js';
import { createSidebar } from './sidebar.js';
import { ICONS } from './icons.js';

let bridge = null;

(async () => {
  const params  = new URLSearchParams(location.search);
  const fileUrl = params.get('src');
  if (!fileUrl) { showError('No PDF source specified.'); return; }

  // Item S6/E4 follow-up: the Assignments entry point opens a signed
  // download URL here — pdfjsLib.getDocument({url}) below already fetches
  // any http(s) URL correctly regardless (confirmed by reading this file
  // before touching it: item 31 already extended this exact loader to
  // ordinary web-served PDFs), so no new loading path was needed, only two
  // additive query params. A signed URL's own query string (signature,
  // expiry) would otherwise show up raw in the toolbar/tab title via the
  // existing fileUrl.split('/').pop() fallback below — `title`, when
  // present, is used instead of deriving one from the URL; local file://
  // and ordinary web PDFs (no `title` param) are completely unaffected,
  // still deriving their filename exactly as before this item.
  const titleOverride = params.get('title');
  const assignmentId = params.get('assignmentId');

  const filenameText = titleOverride
    ? decodeURIComponent(titleOverride)
    : decodeURIComponent(fileUrl.split('/').pop() || fileUrl);
  document.getElementById('filename').textContent = filenameText;
  document.title = filenameText;

  installIcons();

  // Item 29: the escape hatch. Navigates the tab back to the ORIGINAL
  // file:// or http(s) URL — background.js's redirect listener would
  // normally send that straight back here, so the #alcoia-open-native
  // fragment tells it not to, this one time. The fragment has no effect on
  // which document loads.
  function openWithoutAlcoia() {
    const bypassUrl = fileUrl.includes('#') ? fileUrl : fileUrl + '#alcoia-open-native';
    chrome.tabs.getCurrent((tab) => {
      if (tab?.id != null) chrome.tabs.update(tab.id, { url: bypassUrl });
      else location.href = bypassUrl;
    });
  }
  document.getElementById('printBtn').onclick = () => window.print();

  // ── Load PDF.js ───────────────────────────────────────────────────────
  const pdfJsUrl  = chrome.runtime.getURL('src/libs/pdfjs/pdf.min.js');
  const workerUrl = chrome.runtime.getURL('src/libs/pdfjs/pdf.worker.min.js');

  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = pdfJsUrl;
    s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

  // ── Load document ─────────────────────────────────────────────────────
  // scale stays a fixed 1.4 by default rather than auto-fitting to window
  // width on load (native's own "Automatic" default) — found during item 39
  // verification: fit-width reliably lands a normal-width page at a high
  // zoom (2x+) in a typical browser window, and pdf-handler.js's
  // groupTextLayerParagraphs() merges wrapped lines into one paragraph using
  // a FIXED 12px vertical-gap threshold that does not scale with zoom. Past
  // some zoom level a wrapped paragraph's lines stop merging, each fragment
  // falls under paragraph-tracker's 20-word floor, and NO paragraph is ever
  // tracked on that page — silently, exactly the "absence, not error"
  // failure shape CLAUDE.md warns about. This is a pre-existing bug in
  // shared code (a reader manually zooming in today already hits it) that a
  // default-to-fit-width change would turn into the common case rather than
  // an edge case; fixing groupTextLayerParagraphs() itself to scale its
  // threshold is a real but separate fix, out of this item's scope (it is
  // also used by content.js's unrelated manual PDF text-lookup path). Kept
  // here as a known, reported issue rather than fixed or silently avoided.
  let pdfDoc, currentPage = 1, scale = 1.4, rotation = 0;
  let fitMode = 'none';   // 'width' | 'page' | 'none' — native offers no default auto-fit either once you check the actual toolbar behaviour beyond first paint
  let twoPageOn = false;
  let dpr = window.devicePixelRatio || 1;
  // rebuildAllPages()'s own in-flight guard — declared here (not next to the
  // function itself, further down) for the same TDZ reason as everything
  // else in this block: fitWidth() calls rebuildAllPages() once during
  // initial load, before this file's own textual point where a `let` this
  // far down would otherwise sit.
  let rebuilding = false, rebuildQueued = false;
  // Mirrors #toolbar's --bar-h and #viewer's own padding in viewer.html's
  // CSS — used only to estimate available space for fit-width/fit-page, not
  // to lay anything out itself, so a small mismatch here would only make
  // the fit slightly imprecise, never visually wrong.
  const BAR_H = 48, VIEWER_TOP_GAP = 16, VIEWER_BOTTOM_GAP = 40, PAGE_MARGIN = 48;
  const ZOOM_MIN = 0.25, ZOOM_MAX = 4.0; // declared before the initial fitWidth() call below, which reads ZOOM_MAX

  // Declared before use further down deliberately — fitWidth()/fitPage() and
  // updatePageInfo() are all called once during initial load (see below),
  // and `const` has no usable hoisting: referencing one before its own
  // declaration line has executed throws, even inside a function, if that
  // function runs before the line does.
  const viewerEl = document.getElementById('viewer');
  const sidebarPanel = document.getElementById('pdfSidebar');
  const pageInput = document.getElementById('pageInput');

  const loadingTask = pdfjsLib.getDocument({ url: fileUrl });
  // Password-protected PDFs must prompt, not fail silently (native
  // behaviour, previously missing here entirely — an encrypted PDF would
  // just sit on "Loading PDF…" forever with no explanation). pdf.js calls
  // this again on its own after an incorrect attempt, with `reason` set to
  // PasswordResponses.INCORRECT_PASSWORD, so the loop is pdf.js's, not
  // hand-rolled here.
  loadingTask.onPassword = (updatePassword, reason) => {
    const incorrect = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
    showPasswordDialog(updatePassword, incorrect);
  };

  try {
    pdfDoc = await loadingTask.promise;
  } catch (e) {
    // Item 31: a web PDF's load failure — most often an authenticated
    // document the extension page's fetch could not reach the same way the
    // reader's own top-level navigation would have — fails OPEN rather than
    // showing an alcoia error page. The reader always ends up looking at
    // their document, one way or another. Local file:// failures keep the
    // existing message, since bouncing back to the same file:// URL would
    // not fix a permission or corruption problem the way it can for a
    // fetch-layer failure on the web.
    if (/^https?:\/\//i.test(fileUrl)) { openWithoutAlcoia(); return; }
    showError(`Could not load PDF: ${e.message}<br><br>
      Make sure "Allow access to file URLs" is enabled for alcoia in
      <code>chrome://extensions</code>.`);
    return;
  }

  document.getElementById('status').style.display = 'none';

  // Item 30c: alcoia's own reading-signal pipeline, wired to this page's
  // real .textLayer spans. Kicked off concurrently with page rendering below
  // — it only needs to be attached (listeners installed) before
  // primeParagraph() runs, not before any page has actually rendered.
  const bridgePromise = attachReadingBridge({ sourceUrl: fileUrl, assignmentId }).catch((e) => {
    console.warn('[alcoia] reading bridge failed to attach', e);
    return null;
  });

  const pdfHighlights = createPdfHighlights({ sourceUrl: fileUrl, title: filenameText, viewerContainer: viewerEl });
  await pdfHighlights.load();

  const sidebar = createSidebar({
    pdfDoc, container: document.getElementById('pdfSidebar'),
    onJumpToPage: (n) => scrollToPage(n),
    getCurrentPage: () => currentPage,
  });

  // ── Render a single page ────────────────────────────────────────────
  async function renderOnePage(num) {
    const wrap = await renderPage(pdfDoc, num, { scale, rotation, container: viewerEl, dpr });
    pdfHighlights.restoreOnPage(num, wrap);
    pdfHighlights.flashIfRequested(num, wrap);
    return wrap;
  }

  async function renderAllPages() {
    const targetPage = pdfHighlights.pageForRequestedHighlight();
    if (pdfDoc.numPages <= 20) {
      for (let i = 1; i <= pdfDoc.numPages; i++) await renderOnePage(i);
    } else {
      await renderOnePage(1);
      // A highlight's own "open at the exact spot" link should not have to
      // wait on the large-document lazy-render queue behind it.
      if (targetPage && targetPage !== 1) await renderOnePage(targetPage);
      for (let i = 2; i <= pdfDoc.numPages; i++) {
        if (i === targetPage) continue;
        const n = i;
        requestIdleCallback ? requestIdleCallback(() => renderOnePage(n)) : setTimeout(() => renderOnePage(n), n * 80);
      }
    }
  }

  // Initial render at the fixed default scale — see the scale declaration
  // above for why this deliberately does not auto-fit to window width.
  await renderAllPages();
  updatePageInfo();

  bridge = await bridgePromise;
  // A scanned (image-only) PDF renders real pages but an empty text layer —
  // groupTextLayerParagraphs() then finds zero paragraphs, the tracker never
  // has an active paragraph, and no reading signal ever fires. That is the
  // correct degrade-to-silence outcome (invariants 5/9), not a special case
  // handled here — unchanged by this item.
  if (bridge) bridge.primeParagraph();

  const requestedHlPage = pdfHighlights.pageForRequestedHighlight();
  if (requestedHlPage) scrollToPage(requestedHlPage, true);

  // ── Toolbar: page navigation ─────────────────────────────────────────
  function scrollToPage(num, instant) {
    // .page-wrap-scoped deliberately: sidebar.js's thumbnail buttons carry
    // the same data-page attribute for their own purposes (found during
    // item 39 verification — a bare [data-page] selector matched whichever
    // came first in DOM order, which was a sidebar thumbnail, not the
    // actual page, since thumbnails are built eagerly regardless of
    // whether the sidebar panel is open).
    const wrap = document.querySelector(`.page-wrap[data-page="${num}"]`);
    if (wrap) wrap.scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'start' });
    currentPage = num;
    updatePageInfo();
    sidebar.onPageChanged();
  }

  function commitPageInput() {
    const n = Math.max(1, Math.min(pdfDoc.numPages, Number(pageInput.value) || currentPage));
    scrollToPage(n);
  }
  pageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitPageInput(); pageInput.blur(); }
  });
  pageInput.addEventListener('blur', () => { pageInput.value = currentPage; });
  pageInput.addEventListener('click', () => pageInput.select());

  function updatePageInfo() {
    pageInput.value = currentPage;
    document.getElementById('pageCount').textContent = String(pdfDoc.numPages);
  }

  // ── Zoom ──────────────────────────────────────────────────────────────
  function updateZoomLabel() { document.getElementById('zoomPctBtn').textContent = Math.round(scale * 100) + '%'; }

  async function setScale(next) {
    scale = Math.max(ZOOM_MIN, Math.min(next, ZOOM_MAX));
    fitMode = 'none';
    await rebuildAllPages();
  }
  document.getElementById('zoomInBtn').onclick  = () => setScale(scale + 0.2);
  document.getElementById('zoomOutBtn').onclick = () => setScale(scale - 0.2);

  // Item 30d: computed from page 1's own unscaled, unrotated-relative-to-
  // current-rotation viewport — getViewport({ scale: 1, rotation }) already
  // returns width/height with the CURRENT rotation applied, so fitting
  // after a 90°/270° rotation measures against the rotated (swapped)
  // dimensions, not the original page orientation.
  // The sidebar overlays fixed-position rather than sharing a flex layout
  // with #viewer (see viewer.html's layout comment — window scrolling has
  // to stay intact for comprehension-monitor.js), so it does not shrink
  // window.innerWidth on its own; subtracted here instead when open.
  function sidebarWidthIfOpen() {
    return sidebarPanel.classList.contains('open') ? sidebarPanel.getBoundingClientRect().width : 0;
  }
  async function fitWidth() {
    const vp1 = (await pdfDoc.getPage(1)).getViewport({ scale: 1, rotation });
    const cols = twoPageOn ? 2 : 1;
    const availableW = window.innerWidth - sidebarWidthIfOpen() - PAGE_MARGIN;
    scale = Math.max(0.25, Math.min((availableW - (cols - 1) * 14) / (vp1.width * cols), ZOOM_MAX));
    fitMode = 'width';
    await rebuildAllPages();
  }
  async function fitPage() {
    const vp1 = (await pdfDoc.getPage(1)).getViewport({ scale: 1, rotation });
    const availableW = window.innerWidth - sidebarWidthIfOpen() - PAGE_MARGIN;
    const availableH = window.innerHeight - BAR_H - VIEWER_TOP_GAP - VIEWER_BOTTOM_GAP;
    scale = Math.max(0.25, Math.min(availableW / vp1.width, availableH / vp1.height, ZOOM_MAX));
    fitMode = 'page';
    await rebuildAllPages();
  }
  document.getElementById('fitBtn').onclick = () => (fitMode === 'width' ? fitPage() : fitWidth());

  // Rotation is independent of zoom — both feed the same getViewport() call
  // in render.js's renderPage(), and both go through the same
  // rebuildAllPages() below, so the text layer (built from the same
  // viewport object as the canvas) never drifts out of alignment with it
  // after either changes. Native only offers one rotate direction; matched
  // here rather than alcoia's previous separate left/right buttons.
  document.getElementById('rotateBtn').onclick = () => { rotation = (rotation + 90) % 360; rebuildAllPages(); };

  // Item 30d: for an already-local file:// document this duplicates a file
  // already on disk, but item 31 extended this same viewer to web-served
  // PDFs, where there is no local copy to fall back on. pdfDoc.getData()
  // returns the exact bytes pdf.js already fetched — no second network
  // round trip.
  document.getElementById('downloadBtn').onclick = async () => {
    try {
      const data = await pdfDoc.getData();
      const blob = new Blob([data], { type: 'application/pdf' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url;
      a.download = filenameText || 'document.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { console.warn('[alcoia] download failed', e); }
  };

  // Several independent triggers can each ask for a rebuild in quick
  // succession — a resize firing during the very first fitWidth() render,
  // the dpr watcher, a reader clicking zoom repeatedly before a render
  // finishes. Two overlapping rebuilds both clearing and repopulating the
  // SAME #viewer (found during item 39 verification: a resize landing
  // mid-initial-render produced two interleaved sets of .page-wrap
  // elements, some with populated text layers and some without, which is
  // exactly the "silently under-counts paragraphs" failure mode CLAUDE.md
  // warns about) — so calls are coalesced into "run once more after the
  // current one finishes" rather than allowed to interleave.
  async function rebuildAllPages() {
    if (rebuilding) { rebuildQueued = true; return; }
    rebuilding = true;
    try {
      updateZoomLabel();
      viewerEl.innerHTML = '';
      await renderAllPages();
      updateTwoPageWidth();
      // Every previous .textLayer span is gone, replaced by new ones at the
      // new scale — reuse orchestrator.js's existing SPA-route-change reset
      // (item 27) rather than inventing a second reset path for the same
      // shape of problem (in-flight state pointing at DOM that no longer
      // exists).
      if (bridge) bridge.handleRebuild();
      sidebar.rebuildThumbnails();
    } finally {
      rebuilding = false;
    }
    if (rebuildQueued) { rebuildQueued = false; await rebuildAllPages(); }
  }

  function updateTwoPageWidth() {
    if (!twoPageOn) { viewerEl.style.maxWidth = ''; return; }
    const firstPage = viewerEl.querySelector('.page-wrap canvas');
    if (!firstPage) return;
    const w = parseFloat(firstPage.style.width || firstPage.getBoundingClientRect().width);
    viewerEl.style.maxWidth = (w * 2 + 14 + PAGE_MARGIN) + 'px';
  }

  // ── devicePixelRatio can change at runtime (dragging the window between
  // a laptop panel and an external monitor at a different scale factor) —
  // re-render at the new ratio rather than staying pinned to whatever was
  // true when the page first loaded. ──
  watchDevicePixelRatio((newDpr) => { dpr = newDpr; rebuildAllPages(); });

  // A plain resize does not itself move anything: a page's CSS size is
  // fixed by `scale`, independent of window width, unless a fit mode is
  // active — in which case native reflows, so this does too. (Highlight
  // overlay rects are always rebuilt fresh alongside the pages themselves
  // in rebuildAllPages(), so there is nothing separate to recompute here.)
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (fitMode === 'none') return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { fitMode === 'width' ? fitWidth() : fitPage(); }, 150);
  });

  // Update current page indicator as user scrolls
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        currentPage = Number(e.target.dataset.page) || currentPage;
        updatePageInfo();
        sidebar.onPageChanged();
      }
    }
  }, { threshold: 0.5 });
  new MutationObserver(() => {
    document.querySelectorAll('.page-wrap:not([data-observed])').forEach((el) => {
      observer.observe(el); el.dataset.observed = '1';
    });
  }).observe(viewerEl, { childList: true });

  // ── Sidebar toggle ────────────────────────────────────────────────────
  // Native opens the sidebar by default on a fresh load (confirmed against
  // a real screenshot of Chromium's own viewer while building this) rather
  // than starting collapsed — matched here.
  const sidebarToggleBtn = document.getElementById('sidebarToggleBtn');
  function setSidebarOpen(open) {
    sidebarPanel.classList.toggle('open', open);
    viewerEl.classList.toggle('sidebar-open', open);
    sidebarToggleBtn.classList.toggle('active', open);
    sidebarToggleBtn.setAttribute('aria-pressed', String(open));
  }
  sidebarToggleBtn.onclick = () => setSidebarOpen(!sidebarPanel.classList.contains('open'));
  setSidebarOpen(true);

  // ── Zoom preset menu ─────────────────────────────────────────────────
  const zoomPctBtn = document.getElementById('zoomPctBtn');
  zoomPctBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu(zoomPctBtn, [
      { label: '50%',  id: 'zoom50',  action: () => setScale(0.5) },
      { label: '75%',  id: 'zoom75',  action: () => setScale(0.75) },
      { label: '100%', id: 'zoom100', action: () => setScale(1.0) },
      { label: '125%', id: 'zoom125', action: () => setScale(1.25) },
      { label: '150%', id: 'zoom150', action: () => setScale(1.5) },
      { label: '200%', id: 'zoom200', action: () => setScale(2.0) },
      { divider: true },
      { label: 'Fit width', id: 'fitWidth', action: fitWidth },
      { label: 'Fit page',  id: 'fitPage',  action: fitPage },
    ], 'pdf-zoom-menu');
  });

  // ── Kebab menu ────────────────────────────────────────────────────────
  const kebabBtn = document.getElementById('kebabBtn');
  kebabBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu(kebabBtn, [
      { label: 'Two page view', id: 'twoPageView', icon: ICONS.twoPage, checked: twoPageOn, action: toggleTwoPage },
      { label: 'Present',       id: 'present', icon: ICONS.present, action: enterPresentation },
      { label: 'Document properties', id: 'documentProperties', icon: ICONS.properties, action: showPropertiesDialog },
      { divider: true },
      // Item 39: cannot sit in the toolbar as a text button the way it used
      // to (native has no such control there) — moved here, where native
      // puts every other secondary action. Still one click away, same as
      // before.
      { label: 'Open in browser viewer', id: 'openNative', icon: ICONS.openNative, action: openWithoutAlcoia },
    ]);
  });

  function toggleTwoPage() {
    twoPageOn = !twoPageOn;
    viewerEl.classList.toggle('two-page', twoPageOn);
    if (fitMode !== 'none') { (fitMode === 'width' ? fitWidth : fitPage)(); }
    else updateTwoPageWidth();
  }

  async function enterPresentation() {
    try { await document.documentElement.requestFullscreen(); } catch (e) { console.warn('[alcoia] fullscreen failed', e); }
  }
  document.addEventListener('fullscreenchange', () => {
    document.body.classList.toggle('presenting', !!document.fullscreenElement);
  });

  // ── Generic small menu (zoom presets, kebab) ────────────────────────
  let openMenuEl = null;
  function closeMenu() { openMenuEl?.remove(); openMenuEl = null; }
  function openMenu(anchorEl, items, extraClass = '') {
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'pdf-menu' + (extraClass ? ' ' + extraClass : '');
    items.forEach((it) => {
      if (it.divider) { menu.appendChild(document.createElement('hr')); return; }
      const btn = document.createElement('button');
      btn.type = 'button';
      if (it.id) btn.dataset.action = it.id;
      if (it.icon) btn.insertAdjacentHTML('beforeend', it.icon);
      const label = document.createElement('span');
      label.textContent = it.label;
      btn.appendChild(label);
      if ('checked' in it) {
        btn.setAttribute('aria-checked', String(!!it.checked));
        btn.insertAdjacentHTML('beforeend', `<span class="menu-check">${ICONS.check}</span>`);
      }
      btn.addEventListener('click', () => { closeMenu(); it.action(); });
      menu.appendChild(btn);
    });
    document.body.appendChild(menu);
    const r = anchorEl.getBoundingClientRect();
    menu.style.top = (r.bottom + 4) + 'px';
    menu.style.right = (window.innerWidth - r.right) + 'px';
    setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 10);
    openMenuEl = menu;
  }

  // ── Document properties dialog ───────────────────────────────────────
  async function showPropertiesDialog() {
    let info = {};
    try { ({ info } = await pdfDoc.getMetadata()); } catch (e) {}
    let sizeLabel = '';
    try { sizeLabel = formatBytes((await pdfDoc.getData()).length); } catch (e) {}
    const page1 = await pdfDoc.getPage(1);
    const vp1 = page1.getViewport({ scale: 1 });
    const rows = [
      ['File name', filenameText],
      ['File size', sizeLabel],
      ['Title', info.Title || '—'],
      ['Author', info.Author || '—'],
      ['Subject', info.Subject || '—'],
      ['Created', formatPdfDate(info.CreationDate)],
      ['Modified', formatPdfDate(info.ModDate)],
      ['PDF producer', info.Producer || '—'],
      ['PDF version', info.PDFFormatVersion || '—'],
      ['Page count', String(pdfDoc.numPages)],
      ['Page size', `${Math.round(vp1.width)} × ${Math.round(vp1.height)} pt`],
    ];
    const body = `<table class="pdf-props-table">${rows.map(([k, v]) =>
      `<tr><td>${escHtml(k)}</td><td>${escHtml(v)}</td></tr>`).join('')}</table>`;
    showDialog('Document properties', body, [{ label: 'Close', primary: true, action: () => {} }]);
  }
  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }
  function formatPdfDate(d) {
    if (!d || typeof d !== 'string') return '—';
    const m = /^D:(\d{4})(\d{2})(\d{2})/.exec(d);
    if (!m) return d;
    return `${m[1]}-${m[2]}-${m[3]}`;
  }
  function escHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ── Password dialog ──────────────────────────────────────────────────
  function showPasswordDialog(updatePassword, incorrect) {
    const body = `
      ${incorrect ? '<div class="dialog-error">Incorrect password. Try again.</div>' : '<div class="dialog-error"></div>'}
      <input type="password" id="pdfPwInput" autocomplete="off" placeholder="Password">
    `;
    const dlg = showDialog('Password required', body, [
      { label: 'Cancel', secondary: true, action: openWithoutAlcoia },
      { label: 'Submit', primary: true, action: () => updatePassword(dlg.querySelector('#pdfPwInput').value) },
    ], { dismissible: false });
    dlg.querySelector('#pdfPwInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); closeDialog(); updatePassword(dlg.querySelector('#pdfPwInput').value); }
    });
    dlg.querySelector('#pdfPwInput').focus();
  }

  // ── Generic modal dialog ─────────────────────────────────────────────
  let dialogBackdrop = null;
  function closeDialog() { dialogBackdrop?.remove(); dialogBackdrop = null; }
  function showDialog(title, bodyHtml, buttons, { dismissible = true } = {}) {
    closeDialog();
    const backdrop = document.createElement('div');
    backdrop.className = 'pdf-dialog-backdrop';
    const box = document.createElement('div');
    box.className = 'pdf-dialog';
    box.innerHTML = `<h2>${escHtml(title)}</h2><div class="dialog-body">${bodyHtml}</div><div class="dialog-actions"></div>`;
    const actions = box.querySelector('.dialog-actions');
    buttons.forEach((b) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = b.primary ? 'primary' : 'secondary';
      btn.textContent = b.label;
      btn.addEventListener('click', () => { closeDialog(); b.action?.(); });
      actions.appendChild(btn);
    });
    backdrop.appendChild(box);
    if (dismissible) backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeDialog(); });
    document.body.appendChild(backdrop);
    dialogBackdrop = backdrop;
    return box;
  }

  // ── Keyboard shortcuts (native-parity gap list) ─────────────────────
  document.addEventListener('keydown', (e) => {
    const inField = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
    if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); setScale(scale + 0.2); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); setScale(scale - 0.2); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); setScale(1.0); return; }
    if (inField) return;
    if (e.key === 'PageDown') { e.preventDefault(); viewerEl.scrollBy({ top: viewerEl.clientHeight * 0.9, behavior: 'smooth' }); }
    else if (e.key === 'PageUp') { e.preventDefault(); viewerEl.scrollBy({ top: -viewerEl.clientHeight * 0.9, behavior: 'smooth' }); }
    else if (e.key === 'Home') { e.preventDefault(); scrollToPage(1); }
    else if (e.key === 'End') { e.preventDefault(); scrollToPage(pdfDoc.numPages); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); viewerEl.scrollBy({ top: 60, behavior: 'smooth' }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); viewerEl.scrollBy({ top: -60, behavior: 'smooth' }); }
  });

  function installIcons() {
    const map = {
      sidebarToggleBtn: ICONS.sidebar, zoomOutBtn: ICONS.zoomOut, zoomInBtn: ICONS.zoomIn,
      fitBtn: ICONS.fit, rotateBtn: ICONS.rotate, downloadBtn: ICONS.download,
      printBtn: ICONS.print, kebabBtn: ICONS.kebab,
    };
    Object.entries(map).forEach(([id, svg]) => { const el = document.getElementById(id); if (el) el.innerHTML = svg; });
  }

  function showError(msg) {
    document.getElementById('status').style.display = 'none';
    const box = document.getElementById('error-box');
    box.innerHTML = msg; box.style.display = 'block';
  }
})();
