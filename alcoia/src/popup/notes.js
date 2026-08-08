// notes.js — alcoia Notes Dashboard
// External script file (required — Chrome MV3 blocks inline scripts in extension pages)

// Resolve the packaged logos. The relative src in the markup works, but
// getURL is what survives being opened from anywhere.
try {
  const light = document.getElementById('logo-img');
  const dark  = document.getElementById('logo-img-dark');
  if (light) light.src = chrome.runtime.getURL('assets/alcoia-wordmark.png');
  if (dark)  dark.src  = chrome.runtime.getURL('assets/alcoia-wordmark-white.png');
} catch (e) {}

// Follow the theme the reader set in the popup.
try {
  chrome.storage.local.get({ sra_dark_mode: false }, (res) => {
    document.body.classList.toggle('dark-mode', !!res.sra_dark_mode);
  });
} catch (e) {}

// ── State ──────────────────────────────────────────────────────────────────
let allNotes    = [];
let activeFilter = 'all';
let searchQuery  = '';

// ── Load notes from chrome.storage ────────────────────────────────────────
function loadNotes() {
  chrome.storage.local.get({ sra_notes: [] }, (res) => {
    allNotes = res.sra_notes || [];
    renderAll();
  });
}

// ── Render everything ──────────────────────────────────────────────────────
function renderAll() {
  const today = new Date().toDateString();
  document.getElementById('totalCount').textContent = allNotes.length;
  document.getElementById('todayCount').textContent =
    allNotes.filter(n => new Date(n.id).toDateString() === today).length;

  let filtered = [...allNotes];

  if (activeFilter !== 'all') {
    filtered = filtered.filter(n => {
      const src  = n.meta?.source || '';
      const mode = n.meta?.mode   || '';
      if (activeFilter === 'selection')    return src === 'selection' && mode !== 'explain_code';
      // 'gaze' is the legacy value: notes from the reading path carried it even
      // with the camera off, which is where the old "Eye-triggered" tab came
      // from. Both are accepted so existing notes keep filtering.
      if (activeFilter === 'reading')      return src === 'reading' || src === 'gaze';
      if (activeFilter === 'explain_code') return mode === 'explain_code';
      return true;
    });
  }

  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(n => (n.text || '').toLowerCase().includes(q));
  }

  const container = document.getElementById('notesContainer');

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty">
        <div class="empty-title">${allNotes.length === 0 ? 'Nothing saved yet' : 'No matches'}</div>
        <div class="empty-sub">${allNotes.length === 0
          ? 'Select text on any page, or open a card while reading, and choose Save note.'
          : 'Try a different search or filter.'
        }</div>
      </div>`;
    return;
  }

  container.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'notes-grid';
  filtered.forEach(note => grid.appendChild(buildCard(note)));
  container.appendChild(grid);
}

// ── Build a note card ──────────────────────────────────────────────────────
function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
}

function buildCard(note) {
  const card = document.createElement('div');
  card.className = 'note-card';

  const trigger  = note.meta?.trigger || '';
  const mode     = note.meta?.mode    || 'tldr';
  const badgeKey = trigger || mode;
  /* Observation language only. The old table carried 'confused' and
   * 'overloaded', which are internal states this product does not claim to
   * measure — and they would have been sitting in the reader's own saved
   * notes, which is the last place to make a claim you cannot support. */
  const badgeText = {
    selection:    'you selected',
    reading:      'while reading',
    gaze:         'while reading',
    explain_code: 'code',
    struggling:   'you slowed down',
    skimming:     'you sped up',
    drifting:     'you had paused',
    confused:     'you slowed down',
    overloaded:   'you slowed down',
    tldr:         'summary',
    explain_more: 'explanation',
    simplify:     'simplified',
  }[badgeKey] || badgeKey;

  const date    = new Date(note.id);
  const dateStr = isNaN(date) ? '' : date.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  const text   = (note.text || '').trim();
  const isLong = text.length > 300;

  card.innerHTML = `
    <div class="note-header">
      <div class="note-meta">
        <span class="note-badge ${badgeKey}">${badgeText}</span>
        <span class="note-date">${dateStr}</span>
      </div>
      <div class="note-actions">
        <button class="note-action-btn copy-btn" title="Copy text">&#x29c9;</button>
        <button class="note-action-btn delete delete-btn" title="Delete note">&#x2715;</button>
      </div>
    </div>
    <div class="note-text">${escapeHtml(text)}</div>
    ${isLong ? '<button class="note-expand-btn">Read more</button>' : ''}
    <div class="note-source">Saved ${dateStr}</div>`;

  card.querySelector('.copy-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard'));
  });

  card.querySelector('.delete-btn').addEventListener('click', () => {
    deleteNote(note.id);
  });

  const expandBtn = card.querySelector('.note-expand-btn');
  if (expandBtn) {
    expandBtn.addEventListener('click', () => {
      const textEl   = card.querySelector('.note-text');
      const expanded = textEl.classList.toggle('expanded');
      expandBtn.textContent = expanded ? 'Show less' : 'Read more';
    });
  }

  return card;
}

// ── Actions ────────────────────────────────────────────────────────────────
function deleteNote(id) {
  allNotes = allNotes.filter(n => n.id !== id);
  chrome.storage.local.set({ sra_notes: allNotes }, () => {
    renderAll();
    showToast('Note deleted');
  });
}

document.getElementById('clearAllBtn').addEventListener('click', () => {
  if (!confirm('Delete all saved notes? This cannot be undone.')) return;
  chrome.storage.local.set({ sra_notes: [] }, () => {
    allNotes = [];
    renderAll();
    showToast('All notes cleared');
  });
});

document.getElementById('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(allNotes, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `alcoia-notes-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Notes exported');
});

document.getElementById('doneBtn').addEventListener('click', () => window.close());

// ── Filter tabs ────────────────────────────────────────────────────────────
document.getElementById('filterRow').addEventListener('click', (e) => {
  const tab = e.target.closest('.filter-tab');
  if (!tab) return;
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  activeFilter = tab.dataset.filter;
  renderAll();
});

// ── Search ─────────────────────────────────────────────────────────────────
let searchTimer;
document.getElementById('searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { searchQuery = e.target.value; renderAll(); }, 200);
});

// ── Toast ──────────────────────────────────────────────────────────────────
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

// ── Real-time sync (if notes saved in another tab while this is open) ──────
chrome.storage.onChanged.addListener((changes) => {
  if (changes.sra_notes) { allNotes = changes.sra_notes.newValue || []; renderAll(); }
});

// ── Boot ───────────────────────────────────────────────────────────────────
loadNotes();