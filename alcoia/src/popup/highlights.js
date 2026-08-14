const COLOR_MAP = {
  yellow: '#FFF59D', green: '#A5D6A7', blue: '#90CAF9', pink: '#F48FB1', orange: '#FFCC80',
};

let allHighlights = []; // flat list of { entry, urlKey }
let activeFilter  = 'all';

function load() {
  chrome.storage.local.get({ sra_text_highlights: {} }, ({ sra_text_highlights: store }) => {
    allHighlights = [];
    for (const [urlKey, entries] of Object.entries(store)) {
      for (const entry of entries) {
        allHighlights.push({ entry, urlKey });
      }
    }
    allHighlights.sort((a, b) => (b.entry.timestamp || 0) - (a.entry.timestamp || 0));
    render();
  });
}

function render() {
  const list = document.getElementById('list');
  const shown = activeFilter === 'all'
    ? allHighlights
    : allHighlights.filter(({ entry }) => entry.colorKey === activeFilter);

  document.getElementById('countBadge').textContent =
    shown.length + ' highlight' + (shown.length !== 1 ? 's' : '');

  if (!shown.length) {
    list.innerHTML = `<div class="empty">
      <div class="empty-icon">✏️</div>
      <p>No highlights yet.<br>
      Hold <code>Ctrl</code> while selecting text on any page,<br>then pick a colour from the bubble.</p>
    </div>`;
    return;
  }

  list.innerHTML = '';
  shown.forEach(({ entry, urlKey }) => {
    const card = document.createElement('div');
    card.className = 'hl-card';
    card.style.borderLeftColor = COLOR_MAP[entry.colorKey] || entry.color || '#ccc';

    const del = document.createElement('button');
    del.className = 'hl-delete'; del.title = 'Delete highlight'; del.textContent = '×';
    del.addEventListener('click', () => deleteEntry(entry.id, urlKey, card));

    const text = document.createElement('div');
    text.className = 'hl-text';
    text.textContent = '"' + (entry.text || '').slice(0, 300) + (entry.text?.length > 300 ? '…' : '') + '"';

    card.appendChild(del);
    card.appendChild(text);

    // Item 36: only present for a highlight saved with the summarise toggle
    // on, and only once its assist call actually resolved — pre-existing
    // highlights, toggle-off highlights, and failed fetches all simply have
    // no `explanation` field. Rendering nothing for those (rather than an
    // empty "AI explanation" slot) is the sensible presentation for "no
    // explanation exists here", so this block is skipped entirely for them.
    if (entry.explanation) {
      const details = document.createElement('details');
      details.className = 'hl-explanation';
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
    if (entry.url) {
      site.style.cursor = 'pointer';
      site.title = entry.url;
      site.addEventListener('click', () => chrome.tabs.create({ url: entry.url }));
    }

    const date = document.createElement('span');
    date.className = 'hl-date';
    date.textContent = entry.timestamp ? new Date(entry.timestamp).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }) : '';

    // Item 25: delete every highlight on this one document, not just this
    // one highlight or the whole store. Shown on every card for a document
    // (simplest placement — the list isn't grouped by document) rather than
    // once per group.
    const docDelete = document.createElement('span');
    docDelete.className = 'hl-doc-delete';
    docDelete.textContent = 'Delete all on this page';
    docDelete.style.cssText = 'cursor:pointer;text-decoration:underline;';
    docDelete.addEventListener('click', () => deleteDocument(urlKey));

    meta.appendChild(site);
    meta.appendChild(date);
    meta.appendChild(docDelete);
    card.appendChild(meta);
    list.appendChild(card);
  });
}

function deleteEntry(id, urlKey, cardEl) {
  chrome.storage.local.get({ sra_text_highlights: {} }, ({ sra_text_highlights: store }) => {
    if (store[urlKey]) {
      store[urlKey] = store[urlKey].filter(e => e.id !== id);
      if (!store[urlKey].length) delete store[urlKey];
    }
    chrome.storage.local.set({ sra_text_highlights: store }, () => {
      allHighlights = allHighlights.filter(({ entry }) => entry.id !== id);
      cardEl.style.transition = 'opacity 0.2s, max-height 0.25s';
      cardEl.style.opacity = '0';
      cardEl.style.overflow = 'hidden';
      cardEl.style.maxHeight = cardEl.offsetHeight + 'px';
      requestAnimationFrame(() => { cardEl.style.maxHeight = '0'; });
      setTimeout(() => { render(); }, 280);
    });
  });
}

// Item 25: delete every highlight for one document (hostname+pathname key),
// distinct from deleting one highlight or the whole store.
function deleteDocument(urlKey) {
  const count = allHighlights.filter(h => h.urlKey === urlKey).length;
  if (!confirm(`Delete all ${count} highlight${count !== 1 ? 's' : ''} on this page? This cannot be undone.`)) return;
  chrome.storage.local.get({ sra_text_highlights: {} }, ({ sra_text_highlights: store }) => {
    delete store[urlKey];
    chrome.storage.local.set({ sra_text_highlights: store }, () => {
      allHighlights = allHighlights.filter(h => h.urlKey !== urlKey);
      render();
    });
  });
}

document.getElementById('clearAllBtn').addEventListener('click', () => {
  if (!confirm('Delete all saved highlights? This cannot be undone.')) return;
  chrome.storage.local.set({ sra_text_highlights: {} }, () => {
    allHighlights = [];
    render();
  });
});

document.getElementById('controls').addEventListener('click', e => {
  const btn = e.target.closest('[data-color]');
  if (!btn) return;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  activeFilter = btn.dataset.color;
  render();
});

load();
