/* highlights-render.js
 *
 * The one place that reads sra_text_highlights, builds a highlight card, and
 * wires delete / filter / clear-all. Shared by the standalone Highlights
 * page (src/popup/highlights.js) and the in-page highlights sidebar
 * (src/content/highlights-sidebar.js) so the two surfaces cannot silently
 * drift apart into two different feature sets.
 *
 * mountHighlights() only touches the DOM inside the container it is given,
 * found via data-hl-* attributes rather than ids, since the sidebar's
 * container lives inside a real reader's page and a bare id like "list"
 * could collide with something already on that page.
 */

export const HIGHLIGHT_COLOR_MAP = {
  yellow: '#FFF59D', green: '#A5D6A7', blue: '#90CAF9', pink: '#F48FB1', orange: '#FFCC80',
};

// The query param a highlight's own card appends to its source URL, read
// back by content.js on the destination page to scroll to and flash the
// exact passage rather than just landing at the top of the page.
export const HIGHLIGHT_ANCHOR_PARAM = 'sra_hl';

function urlWithHighlightAnchor(entry) {
  try {
    const u = new URL(entry.url);
    u.searchParams.set(HIGHLIGHT_ANCHOR_PARAM, entry.id);
    return u.href;
  } catch (_) {
    return entry.url;
  }
}

/**
 * @param {Element} container - contains [data-hl-list], [data-hl-count],
 *   [data-hl-controls] (the filter buttons), [data-hl-clear-all].
 * @param {{ openUrl: (url: string) => void }} opts - how to navigate to a
 *   highlight's source. An extension page has chrome.tabs.create; a content
 *   script has to proxy through background.js instead, so this is supplied
 *   by the caller rather than assumed here.
 */
export function mountHighlights(container, { openUrl } = {}) {
  const listEl     = container.querySelector('[data-hl-list]');
  const countEl    = container.querySelector('[data-hl-count]');
  const controlsEl = container.querySelector('[data-hl-controls]');
  const clearAllEl = container.querySelector('[data-hl-clear-all]');
  const go = openUrl || ((url) => { window.open(url, '_blank'); });

  let allHighlights = []; // flat list of { entry, urlKey }
  let activeFilter  = 'all';

  function load() {
    chrome.storage.local.get({ sra_text_highlights: {} }, ({ sra_text_highlights: store }) => {
      allHighlights = [];
      for (const [urlKey, entries] of Object.entries(store)) {
        for (const entry of entries) allHighlights.push({ entry, urlKey });
      }
      allHighlights.sort((a, b) => (b.entry.timestamp || 0) - (a.entry.timestamp || 0));
      render();
    });
  }

  function render() {
    if (!listEl) return;
    const shown = activeFilter === 'all'
      ? allHighlights
      : allHighlights.filter(({ entry }) => entry.colorKey === activeFilter);

    if (countEl) countEl.textContent = shown.length + ' highlight' + (shown.length !== 1 ? 's' : '');

    if (!shown.length) {
      listEl.innerHTML = `<div class="hl-empty">
        <div class="hl-empty-icon">✏️</div>
        <p>No highlights yet.<br>
        Hold <code>Ctrl</code> while selecting text on any page, then pick a colour from the bubble.</p>
      </div>`;
      return;
    }

    listEl.innerHTML = '';
    shown.forEach(({ entry, urlKey }) => {
      const card = document.createElement('div');
      card.className = 'hl-card';
      card.style.borderLeftColor = HIGHLIGHT_COLOR_MAP[entry.colorKey] || entry.color || '#ccc';
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.title = entry.url ? 'Open this passage where you highlighted it' : '';

      const goToSource = () => { if (entry.url) go(urlWithHighlightAnchor(entry)); };
      card.addEventListener('click', goToSource);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goToSource(); }
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'hl-delete'; del.title = 'Delete highlight'; del.textContent = '×';
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteEntry(entry.id, urlKey, card); });

      const text = document.createElement('div');
      text.className = 'hl-text';
      text.textContent = '"' + (entry.text || '').slice(0, 300) + (entry.text?.length > 300 ? '...' : '') + '"';

      card.appendChild(del);
      card.appendChild(text);

      // Only present for a highlight saved with the summarise toggle on, and
      // only once its assist call actually resolved.
      if (entry.explanation) {
        const details = document.createElement('details');
        details.className = 'hl-explanation';
        details.addEventListener('click', (e) => e.stopPropagation());
        const summaryEl = document.createElement('summary');
        summaryEl.textContent = 'AI explanation';
        const body = document.createElement('div');
        body.className = 'hl-explanation-text';
        body.textContent = entry.explanation;
        details.appendChild(summaryEl);
        details.appendChild(body);
        card.appendChild(details);
      }

      const meta = document.createElement('div');
      meta.className = 'hl-meta';

      const site = document.createElement('span');
      site.className = 'hl-site';
      site.textContent = entry.title || urlKey;
      if (entry.url) site.title = entry.url;

      const date = document.createElement('span');
      date.className = 'hl-date';
      date.textContent = entry.timestamp ? new Date(entry.timestamp).toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      }) : '';

      // Every highlight on this one document, not just this one highlight or
      // the whole store. Shown on every card for a document (the list isn't
      // grouped by document) rather than once per group.
      const docDelete = document.createElement('span');
      docDelete.className = 'hl-doc-delete';
      docDelete.textContent = 'Delete all on this page';
      docDelete.addEventListener('click', (e) => { e.stopPropagation(); deleteDocument(urlKey); });

      meta.appendChild(site);
      meta.appendChild(date);
      meta.appendChild(docDelete);
      card.appendChild(meta);
      listEl.appendChild(card);
    });
  }

  function deleteEntry(id, urlKey, cardEl) {
    chrome.storage.local.get({ sra_text_highlights: {} }, ({ sra_text_highlights: store }) => {
      if (store[urlKey]) {
        store[urlKey] = store[urlKey].filter((e) => e.id !== id);
        if (!store[urlKey].length) delete store[urlKey];
      }
      chrome.storage.local.set({ sra_text_highlights: store }, () => {
        allHighlights = allHighlights.filter(({ entry }) => entry.id !== id);
        if (!cardEl) { render(); return; }
        cardEl.style.transition = 'opacity 0.2s, max-height 0.25s';
        cardEl.style.opacity = '0';
        cardEl.style.overflow = 'hidden';
        cardEl.style.maxHeight = cardEl.offsetHeight + 'px';
        requestAnimationFrame(() => { cardEl.style.maxHeight = '0'; });
        setTimeout(() => render(), 280);
      });
    });
  }

  function deleteDocument(urlKey) {
    const count = allHighlights.filter((h) => h.urlKey === urlKey).length;
    if (!confirm(`Delete all ${count} highlight${count !== 1 ? 's' : ''} on this page? This cannot be undone.`)) return;
    chrome.storage.local.get({ sra_text_highlights: {} }, ({ sra_text_highlights: store }) => {
      delete store[urlKey];
      chrome.storage.local.set({ sra_text_highlights: store }, () => {
        allHighlights = allHighlights.filter((h) => h.urlKey !== urlKey);
        render();
      });
    });
  }

  clearAllEl?.addEventListener('click', () => {
    if (!confirm('Delete all saved highlights? This cannot be undone.')) return;
    chrome.storage.local.set({ sra_text_highlights: {} }, () => {
      allHighlights = [];
      render();
    });
  });

  controlsEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-color]');
    if (!btn) return;
    controlsEl.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.color;
    render();
  });

  load();
  return { refresh: load };
}
