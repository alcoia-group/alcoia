/*
  PPTX Handler (ES module)
  - Attempts to parse a .pptx file when URL indicates one or when a link/iframe exists
  - Uses JSZip (from CDN) if available to read slide xml and extract text
  - Creates lightweight overlay divs for text boxes, positioned so
    findParagraphAt(x, y) below can hit-test a click against one

  Notes: PPTX support is best-effort. Many viewers transform or rasterize slides; overlay will be used when raw pptx is available.

  This module only locates and extracts text — it never calls a backend or
  renders anything. Fetching a summary and showing a popup for the extracted
  text is content.js's job (triggerAIForParagraph), the same as it is for an
  ordinary DOM paragraph. It used to accept backendUrl/fetchSummary/renderPopup
  and never call any of them — the project notes flagged the unused-var warnings this
  left behind. Removed rather than wired up: inventing what this module would
  do with its own fetch/render path, duplicate of content.js's, is a design
  decision nobody made, not a bug fix.
*/

export async function initPPTXHandler() {
  let overlays = [];
  let parsed = false;

  async function loadLocalJSZip() {
    if (window.JSZip) return window.JSZip;
    try {
      const url = chrome.runtime.getURL('src/libs/jszip.min.js');
      // Prefer dynamic import to avoid CSP/blob issues; fall back to injecting script tag if needed.
      try {
        await import(url);
      } catch (e) {
        await new Promise((res, rej) => { const s = document.createElement('script'); s.src = url; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
      }
      return window.JSZip;
    } catch (e) { console.warn('Local JSZip not available (expected under src/libs/)', e); return null; }
  }

  function findSlideContainer() {
    return document.querySelector('.slide, .punch-viewer, .slides-canvas, .slide-container') || document.body;
  }

  async function parsePptxFromUrl(url) {
    try {
      const JSZip = await loadLocalJSZip(); if (!JSZip) return false;
      const resp = await fetch(url); const ab = await resp.arrayBuffer(); const zip = await JSZip.loadAsync(ab);
      const slideFiles = Object.keys(zip.files).filter(k=>k.startsWith('ppt/slides/slide') && k.endsWith('.xml')).sort();
      let id = 0; const container = findSlideContainer();
      const overlayRoot = document.createElement('div'); overlayRoot.className = 'sra-pptx-overlay'; overlayRoot.style.position='absolute'; overlayRoot.style.left=0; overlayRoot.style.top=0; overlayRoot.style.right=0; overlayRoot.style.bottom=0; overlayRoot.style.pointerEvents='none'; overlayRoot.style.zIndex=2147483645;
      container.style.position = container.style.position || 'relative'; container.appendChild(overlayRoot);
      for (const sf of slideFiles) {
        const xml = await zip.files[sf].async('string');
        const texts = Array.from(xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)).map(m=>m[1]);
        const joined = texts.join(' ');
        const box = document.createElement('div'); box.className='sra-pptx-box'; box.style.position='absolute'; box.style.pointerEvents='auto'; box.style.left='8%'; box.style.top=(8 + id*100) + 'px'; box.style.width='84%'; box.style.padding='8px 12px'; box.style.borderRadius='12px'; box.style.background='transparent'; box.style.color='#222'; box.style.fontFamily='var(--alc-serif, Georgia, serif)'; box.textContent = joined.slice(0,400);
        overlayRoot.appendChild(box);
        await new Promise(r => requestAnimationFrame(r));
        const r = box.getBoundingClientRect(); overlays.push({ id:`pptx-${id++}`, text: joined, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } });
      }
      parsed = true; return true;
    } catch (e) { console.warn('pptx parse failed', e); return false; }
  }

  async function ensureParsed() {
    if (parsed) return;
    const anchors = Array.from(document.querySelectorAll('a[href$=".pptx"], a[href*=".pptx?"]'));
    if (anchors.length) { const url = anchors[0].href; await parsePptxFromUrl(url); return; }
    if (/\.pptx($|[?#])/i.test(window.location.href)) { await parsePptxFromUrl(window.location.href); return; }
    parsed = true;
  }

  async function findParagraphAt(clientX, clientY) {
    await ensureParsed();
    for (const o of overlays) {
      const r = o.rect;
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return o;
    }
    return null;
  }

  async function getParagraphText(par) { return par ? par.text : ''; }

  async function extractSelectedText() { return window.getSelection ? window.getSelection().toString().trim() : ''; }

  return { findParagraphAt, getParagraphText, extractSelectedText };
}
