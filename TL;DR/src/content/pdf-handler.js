/*
  PDF Handler (ES module)
  - Exports initPDFHandler(opts) which scans for PDF textLayers or uses PDF.js
  - Provides: findParagraphAt(x,y), getParagraphText(paragraph), extractSelectedText()

  Notes:
  - Attempts to use existing textLayer (from PDF.js viewer) if present for speed.
  - Falls back to loading pdf.js from CDN and parsing pages lazily.
*/

export async function initPDFHandler(opts = {}) {
  const { backendUrl, fetchSummary, renderPopup } = opts;
  const paragraphs = []; // { id, text, rect, page }
  let parsed = false;

  // helpers to load local pdfjs if available
  async function loadLocalPdfJs() {
    if (window.pdfjsLib) return window.pdfjsLib;
    try {
      const libUrl = chrome.runtime.getURL('src/libs/pdfjs/pdf.min.js');
      const workerUrl = chrome.runtime.getURL('src/libs/pdfjs/pdf.worker.min.js');
      // Try to import as a module (avoids blob URLs). If that fails, fall back to injecting a script tag.
      try {
        await import(libUrl);
      } catch (e) {
        await new Promise((res, rej) => { const s = document.createElement('script'); s.src = libUrl; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
      }
      if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
      return window.pdfjsLib;
    } catch (e) { console.warn('Local pdfjs not available (expected under src/libs/pdfjs/)', e); return null; }
  }

  // Prefer existing textLayer (if viewer already uses PDF.js)
  function indexTextLayers() {
    const textLayers = document.querySelectorAll('.textLayer');
    if (!textLayers || textLayers.length === 0) return false;
    paragraphs.length = 0; let pid = 0;
    textLayers.forEach(layer => {
      const spans = Array.from(layer.querySelectorAll('span')).filter(s=>s.textContent && s.textContent.trim());
      if (!spans.length) return;
      // group spans into lines by rounded top and then group lines into paragraphs
      const lines = [];
      spans.forEach(sp => {
        const r = sp.getBoundingClientRect(); const top = Math.round(r.top);
        let line = lines.find(l => Math.abs(l.top - top) < 6);
        if (!line) { line = { top, spans: [], rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } }; lines.push(line); }
        line.spans.push(sp); line.rect.left = Math.min(line.rect.left, r.left); line.rect.right = Math.max(line.rect.right, r.right); line.rect.bottom = Math.max(line.rect.bottom, r.bottom);
      });
      let cur = null;
      lines.forEach(ln => {
        const txt = ln.spans.map(s=>s.textContent.trim()).join(' ');
        if (!cur) { cur = { id: `pdf-p-${pid++}`, text: txt, rect: Object.assign({}, ln.rect) }; paragraphs.push(cur); }
        else {
          const last = paragraphs[paragraphs.length-1];
          if (Math.abs(ln.top - last.rect.bottom) < 12) { last.text += '\n' + txt; last.rect.bottom = Math.max(last.rect.bottom, ln.rect.bottom); last.rect.right = Math.max(last.rect.right, ln.rect.right); }
          else { cur = { id: `pdf-p-${pid++}`, text: txt, rect: Object.assign({}, ln.rect) }; paragraphs.push(cur); }
        }
      });
    });
    return paragraphs.length > 0;
  }

  // Lazy parse using pdf.js (local). We parse pages incrementally and cache paragraphs.
  async function parseWithPdfJsLazy() {
    const pdfjsLib = await loadLocalPdfJs();
    if (!pdfjsLib) return false;
    try {
      const url = window.location.href;
      const loadingTask = pdfjsLib.getDocument({ url });
      const pdf = await loadingTask.promise;
      const n = pdf.numPages; let pid = paragraphs.length;
      for (let i=1;i<=n;i++) {
        // for big docs, create placeholder entries for each page and parse on demand
        paragraphs.push({ id: `pdf-p-${pid++}`, text: '', rect: { left: 0, top: (i-1)*window.innerHeight, right: window.innerWidth, bottom: i*window.innerHeight }, page: i, parsed: false });
      }
      // parse first page quickly
      if (paragraphs.length) await parsePageIfNeeded(paragraphs[0]);
      return true;
    } catch (e) { console.warn('pdfjs lazy parse failed', e); return false; }
  }

  async function ensureParsed() {
    if (parsed) return; parsed = true;
    const usedText = indexTextLayers();
    if (!usedText) await parseWithPdfJsLazy();
  }

  async function parsePageIfNeeded(par) {
    if (!par || !par.page || par.parsed) return;
    try {
      const pdfjsLib = window.pdfjsLib;
      if (!pdfjsLib) return;
      const loadingTask = pdfjsLib.getDocument({ url: window.location.href });
      const pdf = await loadingTask.promise;
      const page = await pdf.getPage(par.page);
      const content = await page.getTextContent();
      const items = content.items.map(it=>it.str).join(' ');
      par.text = items; par.parsed = true;
    } catch (e) { console.warn('parsePageIfNeeded failed', e); }
  }

  // find paragraph at client coords (viewport coords)
  async function findParagraphAt(clientX, clientY) {
    await ensureParsed();
    // if paragraphs have live DOM rects, re-measure each rect at lookup time for accuracy
    for (const p of paragraphs) {
      if (p.domSpan) {
        const r = p.domSpan.getBoundingClientRect(); p.rect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; 
      }
      // if it's a placeholder with page, derive page rect based on page index and visible canvas if present
      if (p.page && !p.parsed) { await parsePageIfNeeded(p); }
      const r = p.rect; if (!r) continue;
      if (clientX >= r.left - 2 && clientX <= r.right + 2 && clientY >= r.top - 2 && clientY <= r.bottom + 2) return p;
    }
    return null;
  }

  async function getParagraphText(paragraph) {
    if (!paragraph) return '';
    if (paragraph.text && paragraph.text.trim()) return paragraph.text;
    if (paragraph.page) { await parsePageIfNeeded(paragraph); return paragraph.text || ''; }
    return '';
  }

  async function extractSelectedText() {
    const sel = window.getSelection(); return sel ? sel.toString().trim() : '';
  }

  return { findParagraphAt, getParagraphText, extractSelectedText };
}
