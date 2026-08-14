/* viewer.js — the local-PDF viewer's rendering logic, external for MV3.
 *
 * This used to be an inline <script> in viewer.html. MV3's default
 * extension-page CSP is `script-src 'self'`, which blocks inline scripts
 * outright with no exception carved out here — so the inline version never
 * ran at all. Chromium logged the CSP refusal to the console, not as a page
 * error, so `window.status` sat on "Loading PDF…" forever with nothing
 * throwing (see the project notes, "the suite's failure mode is absence, not
 * error" — the same shape, just outside the test suite this time). Moving
 * the identical code to this external file is the fix: same logic, allowed
 * to execute. */
import { attachReadingBridge } from './reading-bridge.js';

let bridge = null;

(async () => {
  const params  = new URLSearchParams(location.search);
  const fileUrl = params.get('src');
  if (!fileUrl) { showError('No PDF source specified.'); return; }

  document.getElementById('filename').textContent =
    decodeURIComponent(fileUrl.split('/').pop() || fileUrl);

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
  document.getElementById('openNativeBtn').onclick = openWithoutAlcoia;
  document.getElementById('printBtn').onclick = () => window.print();

  // ── Load PDF.js ───────────────────────────────────────────────────────
  const pdfJsUrl    = chrome.runtime.getURL('src/libs/pdfjs/pdf.min.js');
  const workerUrl   = chrome.runtime.getURL('src/libs/pdfjs/pdf.worker.min.js');

  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = pdfJsUrl;
    s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

  // ── Load document ─────────────────────────────────────────────────────
  let pdfDoc, currentPage = 1, scale = 1.4;
  try {
    pdfDoc = await pdfjsLib.getDocument({ url: fileUrl }).promise;
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
  updatePageInfo();

  // Item 30c: alcoia's own reading-signal pipeline, wired to this page's
  // real .textLayer spans. Kicked off concurrently with page rendering below
  // — it only needs to be attached (listeners installed) before
  // primeParagraph() runs, not before any page has actually rendered.
  // Attaching only after the document is confirmed to have loaded avoids
  // standing the whole pipeline up on a page that is about to show an error
  // box or bounce back to the browser's own viewer (item 31's fail-open path
  // above already returned before reaching here in that case).
  const bridgePromise = attachReadingBridge({ sourceUrl: fileUrl }).catch((e) => {
    console.warn('[alcoia] reading bridge failed to attach', e);
    return null;
  });

  // Render all pages up front for small docs; render lazily for large ones
  if (pdfDoc.numPages <= 20) {
    for (let i = 1; i <= pdfDoc.numPages; i++) await renderPage(i);
  } else {
    await renderPage(1);
    // Render remaining pages incrementally
    for (let i = 2; i <= pdfDoc.numPages; i++) {
      requestIdleCallback ? requestIdleCallback(() => renderPage(i)) : setTimeout(() => renderPage(i), i * 80);
    }
  }

  bridge = await bridgePromise;
  // A scanned (image-only) PDF renders real pages but an empty text layer —
  // groupTextLayerParagraphs() then finds zero paragraphs, the tracker never
  // has an active paragraph, and no reading signal ever fires. That is the
  // correct degrade-to-silence outcome (invariants 5/9), not a special case
  // handled here.
  if (bridge) bridge.primeParagraph();

  // ── Render a single page ──────────────────────────────────────────────
  async function renderPage(num) {
    const page    = await pdfDoc.getPage(num);
    const vp      = page.getViewport({ scale });
    const wrap    = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.dataset.page = num;

    const canvas  = document.createElement('canvas');
    canvas.width  = vp.width;
    canvas.height = vp.height;
    const ctx     = canvas.getContext('2d');

    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    // Build text layer for selection.
    const textContent = await page.getTextContent();
    const textLayer   = document.createElement('div');
    textLayer.className = 'textLayer';
    textLayer.style.width  = vp.width  + 'px';
    textLayer.style.height = vp.height + 'px';

    // Item 30c: the returned task's completion is now awaited, where this
    // used to be fire-and-forget — pdf.js's renderTextLayer() populates
    // spans asynchronously, and nothing previously needed to know when that
    // finished. Now something does: reading-bridge.js's primeParagraph()
    // scans document.querySelectorAll('.textLayer') immediately once every
    // page's renderPage() call has returned, and an as-yet-unpopulated text
    // layer for a later page (all pages' renderTextLayer() calls fire
    // around the same time) meant paragraph-tracker.js's very first scan
    // permanently saw fewer paragraphs than actually exist — it only
    // rescans lazily every 10s or on an explicit call, never on its own.
    // The task is still started, and the container still attached to the
    // document, in the exact same order as before (only the container's
    // OWN attachment timing is layout-sensitive, not whether its promise is
    // awaited) — only the await itself, at the very end, is new.
    const textLayerTask = pdfjsLib.renderTextLayer({
      textContentSource: textContent,
      container: textLayer,
      viewport: vp,
      textDivs: [],
    });

    wrap.appendChild(canvas);
    wrap.appendChild(textLayer);
    document.getElementById('viewer').appendChild(wrap);

    await textLayerTask.promise;
  }

  // ── Toolbar controls ──────────────────────────────────────────────────
  function scrollToPage(num) {
    const wrap = document.querySelector(`[data-page="${num}"]`);
    if (wrap) wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    currentPage = num;
    updatePageInfo();
  }

  document.getElementById('prevBtn').onclick = () => {
    if (currentPage > 1) scrollToPage(currentPage - 1);
  };
  document.getElementById('nextBtn').onclick = () => {
    if (currentPage < pdfDoc.numPages) scrollToPage(currentPage + 1);
  };
  document.getElementById('zoomInBtn').onclick  = () => { scale = Math.min(scale + 0.2, 3.0); rebuildAllPages(); };
  document.getElementById('zoomOutBtn').onclick = () => { scale = Math.max(scale - 0.2, 0.5); rebuildAllPages(); };

  async function rebuildAllPages() {
    document.getElementById('viewer').innerHTML = '';
    for (let i = 1; i <= pdfDoc.numPages; i++) await renderPage(i);
    // Every previous .textLayer span is gone, replaced by new ones at the
    // new scale — reuse orchestrator.js's existing SPA-route-change reset
    // (item 27) rather than inventing a second reset path for the same
    // shape of problem (in-flight state pointing at DOM that no longer
    // exists).
    if (bridge) bridge.handleRebuild();
  }

  function updatePageInfo() {
    document.getElementById('page-info').textContent =
      `Page ${currentPage} of ${pdfDoc.numPages}`;
  }

  // Update current page indicator as user scrolls
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        currentPage = Number(e.target.dataset.page) || currentPage;
        updatePageInfo();
      }
    }
  }, { threshold: 0.5 });
  // Observe page wraps once they exist
  new MutationObserver(() => {
    document.querySelectorAll('.page-wrap:not([data-observed])').forEach(el => {
      observer.observe(el); el.dataset.observed = '1';
    });
  }).observe(document.getElementById('viewer'), { childList: true });

  function showError(msg) {
    document.getElementById('status').style.display = 'none';
    const box = document.getElementById('error-box');
    box.innerHTML = msg; box.style.display = 'block';
  }
})();
