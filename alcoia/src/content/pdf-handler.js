/*
  PDF Handler (ES module)
  - Exports initPDFHandler() which scans for PDF textLayers or uses PDF.js
  - Provides: findParagraphAt(x,y), getParagraphText(paragraph), extractSelectedText()

  Notes:
  - Attempts to use existing textLayer (from PDF.js viewer) if present for speed.
  - Falls back to loading pdf.js from CDN and parsing pages lazily.

  This module only locates and extracts text — it never calls a backend or
  renders anything. Fetching a summary and showing a popup for the extracted
  text is content.js's job (triggerAIForParagraph), the same as it is for an
  ordinary DOM paragraph. It used to accept backendUrl/fetchSummary/renderPopup
  and never call any of them — the project notes flagged the unused-var warnings this
  left behind. Removed rather than wired up: inventing what this module would
  do with its own fetch/render path, duplicate of content.js's, is a design
  decision nobody made, not a bug fix.
*/

/* Pure, stateless, re-callable grouping of the DOM's current .textLayer spans
 * into paragraphs (line-grouping by rounded top, then line-grouping into
 * paragraphs by vertical proximity) — extracted from indexTextLayers() below
 * so a caller who needs FRESH, LIVE results on every call (item 30c: feeding
 * paragraph-tracker.js's blockSource from inside alcoia's own PDF viewer,
 * where pages render in over time and the reader scrolls) doesn't have to
 * duplicate this algorithm or go through initPDFHandler()'s own `parsed`
 * latch, which is deliberately one-shot (see ensureParsed() below) and wrong
 * for that use: it would freeze the paragraph list at whatever had rendered
 * the first time anything called findParagraphAt()/getParagraphText().
 *
 * Each returned entry keeps its real `spans` (live DOM references, not a
 * frozen rect) specifically so a caller can compute a bounding rect fresh
 * every time it is asked — exactly the same "always live" contract
 * paragraph-tracker.js's DOM path already has via a real element's own
 * getBoundingClientRect(). indexTextLayers() below still only takes rect a
 * single snapshot per call (its existing, unchanged behaviour for manual
 * point-lookup extraction) — this export changes nothing about that path,
 * it only factors out the part both paths already needed identically. */
export function groupTextLayerParagraphs(doc = document) {
  const textLayers = doc.querySelectorAll('.textLayer');
  if (!textLayers || textLayers.length === 0) return [];
  const out = [];
  let pid = 0;
  textLayers.forEach((layer) => {
    const spans = Array.from(layer.querySelectorAll('span')).filter((s) => s.textContent && s.textContent.trim());
    if (!spans.length) return;
    const lines = [];
    spans.forEach((sp) => {
      const r = sp.getBoundingClientRect();
      const top = Math.round(r.top);
      let line = lines.find((l) => Math.abs(l.top - top) < 6);
      if (!line) { line = { top, spans: [], bottom: r.bottom }; lines.push(line); }
      line.spans.push(sp);
      line.bottom = Math.max(line.bottom, r.bottom);
    });
    let cur = null;
    lines.forEach((ln) => {
      const txt = ln.spans.map((s) => s.textContent.trim()).join(' ');
      if (!cur) {
        cur = { id: `pdf-p-${pid++}`, text: txt, spans: [...ln.spans], bottom: ln.bottom };
        out.push(cur);
      } else {
        const last = out[out.length - 1];
        if (Math.abs(ln.top - last.bottom) < 12) {
          last.text += '\n' + txt;
          last.spans.push(...ln.spans);
          last.bottom = Math.max(last.bottom, ln.bottom);
        } else {
          cur = { id: `pdf-p-${pid++}`, text: txt, spans: [...ln.spans], bottom: ln.bottom };
          out.push(cur);
        }
      }
    });
  });
  return out.map(({ id, text, spans }) => ({ id, text, spans }));
}

/* Union bounding rect of a group's live spans, measured fresh every call —
 * the same "ask the DOM again, right now" contract a real element's own
 * getBoundingClientRect() has. Empty/detached spans are skipped rather than
 * thrown on, matching paragraph-tracker.js's own try/catch around a
 * DOM-element rect read. */
export function unionRect(spans) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const sp of spans) {
    let r;
    try { r = sp.getBoundingClientRect(); } catch (e) { continue; }
    if (r.width === 0 && r.height === 0) continue;
    left = Math.min(left, r.left); top = Math.min(top, r.top);
    right = Math.max(right, r.right); bottom = Math.max(bottom, r.bottom);
  }
  if (!Number.isFinite(left)) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

export async function initPDFHandler() {
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

  // Prefer existing textLayer (if viewer already uses PDF.js). Shares its
  // grouping algorithm with groupTextLayerParagraphs() above (item 30c) —
  // this wrapper still takes one rect snapshot at index time, unchanged from
  // before; a caller wanting live-remeasured rects on every call (the
  // paragraph tracker feed) calls groupTextLayerParagraphs()/unionRect()
  // directly instead of going through this one-shot-latched path.
  function indexTextLayers() {
    const groups = groupTextLayerParagraphs(document);
    if (!groups.length) return false;
    paragraphs.length = 0;
    groups.forEach((g) => { paragraphs.push({ id: g.id, text: g.text, rect: unionRect(g.spans) }); });
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
