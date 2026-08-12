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
(async () => {
  const params  = new URLSearchParams(location.search);
  const fileUrl = params.get('src');
  if (!fileUrl) { showError('No PDF source specified.'); return; }

  document.getElementById('filename').textContent =
    decodeURIComponent(fileUrl.split('/').pop() || fileUrl);

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
    showError(`Could not load PDF: ${e.message}<br><br>
      Make sure "Allow access to file URLs" is enabled for alcoia in
      <code>chrome://extensions</code>.`);
    return;
  }

  document.getElementById('status').style.display = 'none';
  updatePageInfo();

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

    pdfjsLib.renderTextLayer({
      textContentSource: textContent,
      container: textLayer,
      viewport: vp,
      textDivs: [],
    });

    wrap.appendChild(canvas);
    wrap.appendChild(textLayer);
    document.getElementById('viewer').appendChild(wrap);
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
