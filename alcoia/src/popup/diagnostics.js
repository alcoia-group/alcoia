// diagnostics.js — the one place a reader's own extension is honest about
// what has been silently failing (invariant 9 means everything else stays
// quiet). Safe to screenshot: nothing here ever reads the current tab, a
// page title, a page URL, or passage text. See diagnostics.html's header
// comment and diag-log.js's for the reasoning.
import { createDiagLog } from '../shared/diag-log.js';
import { maskToken, relativeTime, escapeHtml } from './diagnostics-format.js';

const $ = (id) => document.getElementById(id);

// ── Logo + dark mode (same pattern as upgrade.js / notes.js) ──────────────
$('logo-img').src = chrome.runtime.getURL('assets/alcoia-wordmark.png');
$('logo-img-dark').src = chrome.runtime.getURL('assets/alcoia-wordmark-white.png');
chrome.storage.local.get({ sra_dark_mode: false }, (res) => {
  document.body.classList.toggle('dark-mode', !!res.sra_dark_mode);
});
$('closeBtn').addEventListener('click', () => window.close());

// ── Extension ───────────────────────────────────────────────────────────
const manifest = chrome.runtime.getManifest();
$('val-version').textContent = manifest.version || '—';
$('val-buildTarget').textContent = manifest.version_name || manifest.version || '—';

// ── Install token ───────────────────────────────────────────────────────
function renderToken(token) {
  $('val-tokenStatus').textContent = token ? 'Issued' : 'Not issued yet';
  $('val-tokenMasked').textContent = maskToken(token);
}

chrome.storage.local.get({ sra_install_token: null }, (res) => renderToken(res.sra_install_token));

$('deleteTokenBtn').addEventListener('click', () => {
  chrome.storage.local.set({ sra_install_token: null }, () => renderToken(null));
});

// ── Settings (local) ───────────────────────────────────────────────────
// Every sra_* preference content.js reads, with plain labels — this is
// exactly what is already editable from the toolbar popup, just gathered
// in one read-only place for support.
const SETTINGS_FIELDS = [
  ['sra_enabled', 'Assistant on', (v) => (v !== false ? 'On' : 'Off')],
  ['sra_comprehension', 'Reading signals', (v) => (v !== false ? 'On' : 'Off')],
  ['sra_selection', 'Selection summaries', (v) => (v !== false ? 'On' : 'Off')],
  ['sra_highlight_para', 'Show the passage', (v) => (v !== false ? 'On' : 'Off')],
  ['sra_tts', 'Read aloud', (v) => (v ? 'On' : 'Off')],
  ['sra_focus_ruler', 'Focus ruler', (v) => (v ? 'On' : 'Off')],
  ['sra_dyslexia', 'Dyslexia mode', (v) => (v ? 'On' : 'Off')],
  ['sra_autohide', 'Auto-dismiss cards', (v) => (v ? 'On' : 'Off')],
  ['sra_pin_default', 'Pin by default', (v) => (v ? 'On' : 'Off')],
  ['sra_dark_mode', 'Dark mode', (v) => (v ? 'On' : 'Off')],
  ['sra_baseline_wpm', 'Reading-speed baseline', (v) => (v ? `${Math.round(v)} wpm` : null)],
  ['sra_backend_url', 'Backend URL', (v) => v || null],
];

chrome.storage.local.get(
  Object.fromEntries(SETTINGS_FIELDS.map(([key]) => [key, null])),
  (res) => {
    const grid = $('settingsGrid');
    for (const [key, label, format] of SETTINGS_FIELDS) {
      const formatted = format(res[key]);
      const row = document.createElement('div');
      row.className = 'kv-row';
      row.innerHTML = `<span class="kv-key">${label}</span>` +
        (formatted != null
          ? `<span class="kv-val">${escapeHtml(String(formatted))}</span>`
          : `<span class="kv-val unavailable">Not set</span>`);
      grid.appendChild(row);
    }
  }
);

// ── Recent errors ───────────────────────────────────────────────────────
const diagLog = createDiagLog();

async function renderLog() {
  const entries = await diagLog.list();
  const list = $('errorLog');
  list.innerHTML = '';
  if (!entries.length) {
    list.innerHTML = '<div class="log-empty">No AI-call failures recorded.</div>';
    return;
  }
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'log-row';
    row.innerHTML =
      `<span class="log-ctx">${escapeHtml(entry.context)}</span>` +
      `<span class="log-msg">${escapeHtml(entry.message)}</span>` +
      `<span class="log-at">${escapeHtml(relativeTime(entry.at))}</span>`;
    list.appendChild(row);
  }
}

$('clearLogBtn').addEventListener('click', async () => {
  await diagLog.clear();
  renderLog();
});

renderLog();
