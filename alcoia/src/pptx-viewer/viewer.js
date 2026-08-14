/* viewer.js — the local-PPTX viewer's rendering logic, external for MV3.
 *
 * Was an inline <script> in viewer.html; MV3's default extension-page CSP
 * (`script-src 'self'`) blocks inline scripts with no exception carved out
 * here, so it never ran — see pdf-viewer/viewer.js's header for the full
 * account of the same defect on the PDF side. Identical logic, moved to an
 * external file so it actually executes. */
(async () => {
  const params  = new URLSearchParams(location.search);
  const fileUrl = params.get('src');
  if (!fileUrl) { showError('No PPTX source specified.'); return; }

  document.getElementById('filename').textContent =
    decodeURIComponent(fileUrl.split('/').pop() || fileUrl);

  // Item 29: the escape hatch. See pdf-viewer/viewer.js's identical handler
  // for the full reasoning on the #alcoia-open-native fragment. Chrome has
  // no native PPTX renderer, so unlike the PDF viewer this typically hands
  // the reader a download rather than an in-browser view — still a real way
  // out, just not a browser-native viewer, which is why the button and its
  // tooltip say "without alcoia" rather than "in your browser".
  document.getElementById('openNativeBtn').onclick = () => {
    const bypassUrl = fileUrl.includes('#') ? fileUrl : fileUrl + '#alcoia-open-native';
    chrome.tabs.getCurrent((tab) => {
      if (tab?.id != null) chrome.tabs.update(tab.id, { url: bypassUrl });
      else location.href = bypassUrl;
    });
  };
  document.getElementById('printBtn').onclick = () => window.print();

  // ── Load JSZip ────────────────────────────────────────────────────────
  const jszipUrl = chrome.runtime.getURL('src/libs/jszip.min.js');
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = jszipUrl; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });

  // ── Fetch and parse PPTX ──────────────────────────────────────────────
  let slides = [];
  try {
    const resp = await fetch(fileUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const ab  = await resp.arrayBuffer();
    const zip = await JSZip.loadAsync(ab);

    const slideFiles = Object.keys(zip.files)
      .filter(k => /^ppt\/slides\/slide\d+\.xml$/i.test(k))
      .sort((a, b) => {
        const na = parseInt(a.match(/\d+/)?.[0] || 0);
        const nb = parseInt(b.match(/\d+/)?.[0] || 0);
        return na - nb;
      });

    for (const sf of slideFiles) {
      const xml = await zip.files[sf].async('string');
      slides.push(parseSlide(xml));
    }
  } catch (e) {
    showError(`Could not load PPTX: ${e.message}<br><br>
      Make sure "Allow access to file URLs" is enabled for alcoia in <code>chrome://extensions</code>.`);
    return;
  }

  if (!slides.length) {
    showError('No slides found in this file. The PPTX may be empty or use an unsupported format.');
    return;
  }

  document.getElementById('status').style.display = 'none';
  slides.forEach((slide, i) => renderSlide(slide, i + 1, slides.length));
  updateInfo(1, slides.length);

  // ── Parse a slide's XML into { title, body } ──────────────────────────
  function parseSlide(xml) {
    // Group by paragraph (<a:p>...</a:p>)
    const paras = [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)];
    const paraTexts = paras.map(m => {
      const runs = [...m[1].matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)];
      return runs.map(r => r[1]).join('').trim();
    }).filter(Boolean);

    // First non-empty para is the title if it has a distinct sp type or is short
    let title = '', body = [];
    if (paraTexts.length > 0) {
      title = paraTexts[0];
      body  = paraTexts.slice(1);
    }

    return { title, body };
  }

  // ── Render a slide as a DOM card ──────────────────────────────────────
  function renderSlide(slide, num, total) {
    const wrap = document.createElement('div');
    wrap.className = 'slide-wrap';
    wrap.dataset.slide = num;

    const numEl = document.createElement('div');
    numEl.className = 'slide-num';
    numEl.textContent = `${num} / ${total}`;

    const titleEl = document.createElement('div');
    titleEl.className = 'slide-title';
    titleEl.textContent = slide.title || `Slide ${num}`;

    const bodyEl = document.createElement('div');
    bodyEl.className = 'slide-body';
    slide.body.forEach(line => {
      const p = document.createElement('p');
      p.textContent = line;
      bodyEl.appendChild(p);
    });

    wrap.appendChild(numEl);
    wrap.appendChild(titleEl);
    wrap.appendChild(bodyEl);
    document.getElementById('viewer').appendChild(wrap);
  }

  // ── Navigation ────────────────────────────────────────────────────────
  let current = 1;
  function scrollTo(num) {
    const el = document.querySelector(`[data-slide="${num}"]`);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); current = num; updateInfo(num, slides.length); }
  }
  document.getElementById('prevBtn').onclick = () => { if (current > 1) scrollTo(current - 1); };
  document.getElementById('nextBtn').onclick = () => { if (current < slides.length) scrollTo(current + 1); };

  // Update current slide as user scrolls
  const obs = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) {
        current = Number(e.target.dataset.slide) || current;
        updateInfo(current, slides.length);
      }
    }
  }, { threshold: 0.5 });
  new MutationObserver(() => {
    document.querySelectorAll('.slide-wrap:not([data-observed])').forEach(el => {
      obs.observe(el); el.dataset.observed = '1';
    });
  }).observe(document.getElementById('viewer'), { childList: true });

  function updateInfo(cur, total) {
    document.getElementById('slide-info').textContent = `Slide ${cur} of ${total}`;
  }

  function showError(msg) {
    document.getElementById('status').style.display = 'none';
    const box = document.getElementById('error-box');
    box.innerHTML = msg; box.style.display = 'block';
  }
})();
