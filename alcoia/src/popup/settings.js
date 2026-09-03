/* settings.js — the dedicated settings page (item 15a-1)
 *
 * Every toggle here is ported from popup.js's former Assist/Reading/Session
 * tabs — same storage key, same default, same write/broadcast behaviour.
 * This item moves WHERE a switch lives, never WHAT it does; see popup.html's
 * old markup (still in git history) and popup.js's old saveAndBroadcast()
 * for the pre-move logic this file must match exactly.
 *
 * A real ES module (unlike popup.js, a classic script) — so the Account
 * group reuses src/shared/session.js directly, the same pattern account.js
 * uses, rather than the ad-hoc storage-read popup.js had to duplicate. This
 * also fixes a real inconsistency found while moving it: popup.js's old
 * sign-out button did a bare `chrome.storage.local.remove('sra_session')`
 * instead of calling session.js's own clearSession() — harmless in
 * practice (same key, same effect) but a second definition of "signed out"
 * that this file does not repeat.
 *
 * sra_enabled (the master switch) is also shown in popup.html's reading-mode
 * header — both write the same key and rely on every open tab's own
 * chrome.storage.onChanged listener to stay in sync, exactly as popup.js's
 * old header pill always did. This page also listens for storage changes
 * made elsewhere (popup.html's header, or another settings tab) so it never
 * shows a stale checked state.
 */
import { createSessionManager } from '../shared/session.js';

const $ = (id) => document.getElementById(id);

$('logo-img').src = chrome.runtime.getURL('assets/alcoia-wordmark.png');
$('logo-img-dark').src = chrome.runtime.getURL('assets/alcoia-wordmark-white.png');
chrome.storage.local.get({ sra_dark_mode: false }, (res) => {
  document.body.classList.toggle('dark-mode', !!res.sra_dark_mode);
});
$('closeBtn').addEventListener('click', () => window.close());

// ── Elements ────────────────────────────────────────────────────────────
const assistantToggle          = $('assistantToggle');
const comprehensionToggle      = $('comprehensionToggle');
const selToggle                = $('selToggle');
const highlightToggle          = $('highlightToggle');
const highlightColorToggle     = $('highlightColorToggle');
const highlightPersistToggle   = $('highlightPersistToggle');
const highlightSummarizeToggle = $('highlightSummarizeToggle');
const ttsToggle                = $('ttsToggle');
const focusRulerToggle         = $('focusRulerToggle');
const autohideToggle           = $('autohideToggle');
const autohideTimeout          = $('autohideTimeout');
const timeoutRow               = $('timeoutRow');
const pinDefaultToggle         = $('pinDefaultToggle');
const darkModeToggle           = $('darkModeToggle');
const dyslexiaToggle           = $('dyslexiaToggle');
const dyslexiaOptions          = $('dyslexiaOptions');
const bionicToggle             = $('bionicToggle');
const dyslexiaColorSelect      = $('dyslexiaColorSelect');
const debugToggle              = $('debugToggle');
const pdfTakeoverToggle        = $('pdfTakeoverToggle');
const webPdfTakeoverToggle     = $('webPdfTakeoverToggle');

// ── Defaults — identical to popup.js's own DEFAULTS object ────────────────
const DEFAULTS = {
  sra_backend_url: self.ALCOIA_CONFIG.SUMMARIZE_URL,
  sra_selection: true, sra_highlight_para: true,
  sra_highlight_color: true, sra_highlight_summarize: false,
  sra_highlight_persist: true,
  sra_autohide: false, sra_autohide_timeout: 12,
  sra_pin_default: false, sra_debug: false, sra_enabled: true,
  sra_comprehension: true,
  sra_tts: false, sra_focus_ruler: false,
  sra_dyslexia: false, sra_dyslexia_color: 'rgba(255,243,180,0.12)', sra_bionic: false,
  sra_dark_mode: false, sra_active_persona: '',
  sra_pdf_takeover: true,
  sra_web_pdf_takeover: false,
};

function paint(res) {
  assistantToggle.checked     = res.sra_enabled !== false;
  comprehensionToggle.checked = res.sra_comprehension !== false;
  selToggle.checked           = res.sra_selection !== false;
  highlightToggle.checked     = res.sra_highlight_para !== false;
  highlightColorToggle.checked     = res.sra_highlight_color !== false;
  highlightPersistToggle.checked   = res.sra_highlight_persist !== false;
  highlightSummarizeToggle.checked = !!res.sra_highlight_summarize;
  ttsToggle.checked           = !!res.sra_tts;
  focusRulerToggle.checked    = !!res.sra_focus_ruler;
  autohideToggle.checked      = !!res.sra_autohide;
  autohideTimeout.value       = res.sra_autohide_timeout;
  timeoutRow.style.display    = res.sra_autohide ? 'flex' : 'none';
  pinDefaultToggle.checked    = !!res.sra_pin_default;
  syncPinAutohideExclusivity();
  darkModeToggle.checked      = !!res.sra_dark_mode;
  document.body.classList.toggle('dark-mode', !!res.sra_dark_mode);
  dyslexiaToggle.checked      = !!res.sra_dyslexia;
  dyslexiaOptions.style.display = res.sra_dyslexia ? 'block' : 'none';
  bionicToggle.checked        = !!res.sra_bionic;
  dyslexiaColorSelect.value   = res.sra_dyslexia_color || '';
  debugToggle.checked         = !!res.sra_debug;
  pdfTakeoverToggle.checked   = res.sra_pdf_takeover !== false;
  webPdfTakeoverToggle.checked = !!res.sra_web_pdf_takeover;

  if (res.sra_active_persona) {
    document.querySelectorAll('.mode-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.persona === res.sra_active_persona));
  }
}

chrome.storage.local.get(DEFAULTS, paint);

// Stays in sync with the popup's own header pill (or another open settings
// tab) writing the SAME sra_enabled key — same requirement popup.js's old
// master switch already satisfied for every open tab via this listener.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (Object.keys(changes).some((k) => k in DEFAULTS)) {
    chrome.storage.local.get(DEFAULTS, paint);
  }
});

// ── Save & broadcast — ported verbatim from popup.js's saveAndBroadcast() ─
function saveAndBroadcast() {
  const s = {
    sra_selection:        selToggle.checked,
    sra_highlight_para:   highlightToggle.checked,
    sra_highlight_color:      highlightColorToggle.checked,
    sra_highlight_persist:    highlightPersistToggle.checked,
    sra_highlight_summarize:  highlightSummarizeToggle.checked,
    sra_autohide:         autohideToggle.checked,
    sra_autohide_timeout: Number(autohideTimeout.value) || 12,
    sra_pin_default:      pinDefaultToggle.checked,
    sra_debug:            debugToggle.checked,
    sra_comprehension:    comprehensionToggle.checked,
    sra_tts:              ttsToggle.checked,
    sra_focus_ruler:      focusRulerToggle.checked,
    sra_dyslexia:         dyslexiaToggle.checked,
    sra_dyslexia_color:   dyslexiaColorSelect.value,
    sra_bionic:           bionicToggle.checked,
    sra_dark_mode:        darkModeToggle.checked,
  };
  chrome.storage.local.set(s);
  document.body.classList.toggle('dark-mode', s.sra_dark_mode);

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs?.[0]) return;
    chrome.storage.local.get({ sra_backend_url: self.ALCOIA_CONFIG.SUMMARIZE_URL }, (r) => {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'settings',
        backendUrl: r.sra_backend_url,
        selection: s.sra_selection,
        highlightPara: s.sra_highlight_para,
        highlightColor: s.sra_highlight_color,
        highlightPersist: s.sra_highlight_persist,
        highlightSummarize: s.sra_highlight_summarize,
        autohide: s.sra_autohide, autohideTimeout: s.sra_autohide_timeout,
        pinDefault: s.sra_pin_default, debug: s.sra_debug,
        comprehension: s.sra_comprehension,
        tts: s.sra_tts, focusRuler: s.sra_focus_ruler,
        dyslexia: s.sra_dyslexia, dyslexiaColor: s.sra_dyslexia_color,
        bionic: s.sra_bionic,
        darkMode: s.sra_dark_mode,
      }, () => { if (chrome.runtime.lastError) { /* no content script here */ } });
      chrome.tabs.sendMessage(tabs[0].id, { type: 'debugToggle', enabled: s.sra_debug },
        () => { if (chrome.runtime.lastError) { /* no content script here */ } });
    });
  });
}

// ── Toggles — same special-case behaviour as popup.js, ported exactly ─────
// Master switch: writing the key is enough — every open tab (including this
// one, via the onChanged listener above) hears it, so a broadcast to just
// the active tab would miss the others.
assistantToggle.addEventListener('change', () => {
  chrome.storage.local.set({ sra_enabled: assistantToggle.checked });
});
// Read directly by background.js's redirect listener, not any content
// script — a plain storage write is enough; the effect is on the next
// navigation, not the current tab.
pdfTakeoverToggle.addEventListener('change', () => {
  chrome.storage.local.set({ sra_pdf_takeover: pdfTakeoverToggle.checked });
});
webPdfTakeoverToggle.addEventListener('change', () => {
  chrome.storage.local.set({ sra_web_pdf_takeover: webPdfTakeoverToggle.checked });
});
autohideToggle.addEventListener('change', () => {
  timeoutRow.style.display = autohideToggle.checked ? 'flex' : 'none';
  saveAndBroadcast();
});
function syncPinAutohideExclusivity() {
  autohideToggle.disabled = pinDefaultToggle.checked;
  if (pinDefaultToggle.checked && autohideToggle.checked) {
    autohideToggle.checked = false;
    timeoutRow.style.display = 'none';
  }
}
pinDefaultToggle.addEventListener('change', () => {
  syncPinAutohideExclusivity();
  saveAndBroadcast();
});
dyslexiaToggle.addEventListener('change', () => {
  dyslexiaOptions.style.display = dyslexiaToggle.checked ? 'block' : 'none';
  saveAndBroadcast();
});
// Turning persistence off must never silently delete highlights already
// saved from when it was on — ask once, default to keeping them.
highlightPersistToggle.addEventListener('change', () => {
  if (highlightPersistToggle.checked) { saveAndBroadcast(); return; }
  chrome.storage.local.get({ sra_text_highlights: {} }, ({ sra_text_highlights: store }) => {
    const hasStored = Object.values(store).some((entries) => entries?.length);
    if (hasStored) {
      const clear = confirm(
        'Turning this off does not delete highlights you already saved.\n\n' +
        'Delete all saved highlights now instead? This cannot be undone.\n\n' +
        '(Cancel keeps them.)'
      );
      if (clear) chrome.storage.local.set({ sra_text_highlights: {} });
    }
    saveAndBroadcast();
  });
});
[selToggle, highlightToggle, highlightColorToggle, highlightSummarizeToggle,
 debugToggle, comprehensionToggle, ttsToggle, focusRulerToggle,
 bionicToggle, darkModeToggle]
  .forEach((el) => el.addEventListener('change', saveAndBroadcast));
[autohideTimeout, dyslexiaColorSelect]
  .forEach((el) => el.addEventListener('change', saveAndBroadcast));

// ── Reading mode presets — ported from popup.js's MODES/applyMode() ───────
const MODES = {
  research: { sra_selection: true,  sra_highlight_para: true,  sra_comprehension: true,  sra_focus_ruler: true,  sra_autohide: false, sra_pin_default: true,  sra_tts: false },
  study:    { sra_selection: true,  sra_highlight_para: true,  sra_comprehension: true,  sra_focus_ruler: false, sra_autohide: true,  sra_autohide_timeout: 10, sra_pin_default: false, sra_tts: true },
  casual:   { sra_selection: true,  sra_highlight_para: false, sra_comprehension: false, sra_focus_ruler: false, sra_autohide: true,  sra_autohide_timeout: 6,  sra_pin_default: false, sra_tts: false },
  speed:    { sra_selection: false, sra_highlight_para: false, sra_comprehension: false, sra_focus_ruler: true,  sra_autohide: true,  sra_autohide_timeout: 4,  sra_pin_default: false, sra_tts: false },
};

function applyMode(key) {
  const p = MODES[key];
  if (!p) return;
  chrome.storage.local.set({ ...p, sra_active_persona: key });

  selToggle.checked           = !!p.sra_selection;
  highlightToggle.checked     = !!p.sra_highlight_para;
  comprehensionToggle.checked = !!p.sra_comprehension;
  focusRulerToggle.checked    = !!p.sra_focus_ruler;
  autohideToggle.checked      = !!p.sra_autohide;
  pinDefaultToggle.checked    = !!p.sra_pin_default;
  ttsToggle.checked           = !!p.sra_tts;
  if (p.sra_autohide_timeout) autohideTimeout.value = p.sra_autohide_timeout;
  timeoutRow.style.display = p.sra_autohide ? 'flex' : 'none';
  syncPinAutohideExclusivity();

  document.querySelectorAll('.mode-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.persona === key));

  saveAndBroadcast();
}

document.querySelectorAll('.mode-btn').forEach((btn) =>
  btn.addEventListener('click', () => applyMode(btn.dataset.persona)));

// ── Account (item S3 pattern, reused not reimplemented) ───────────────────
const session = createSessionManager();

async function refreshAccountStatus() {
  const current = await session.getSession();
  $('accountSignedOut').hidden = !!current;
  $('accountSignedIn').hidden  = !current;
  if (current) $('accountEmail').textContent = current.email || '';
}
refreshAccountStatus();

$('signInBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/account.html') });
});
$('signOutBtn').addEventListener('click', async () => {
  await session.clearSession();
  refreshAccountStatus();
});

// Same-key change elsewhere (e.g. a sign-in completed in another tab) keeps
// this page's account status honest without a reload.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (self.ALCOIA_CONFIG.SESSION_STORAGE_KEY in changes) refreshAccountStatus();
});

// ── Backend URL (advanced, collapsible) ────────────────────────────────────
// Same read/write pattern diagnostics.js's own dev-tools field already
// uses for this exact key — kept there too (see settings.html's own note);
// this is an additive second place to reach it, not a replacement.
$('advancedToggle').addEventListener('click', () => {
  const el = $('accountAdvanced');
  const open = el.style.display === 'block';
  el.style.display = open ? 'none' : 'block';
  $('advancedToggle').textContent = open ? 'Advanced ▾' : 'Advanced ▴';
});
$('backendUrlInput').placeholder = self.ALCOIA_CONFIG.SUMMARIZE_URL;
chrome.storage.local.get({ sra_backend_url: self.ALCOIA_CONFIG.SUMMARIZE_URL }, (res) => {
  $('backendUrlInput').value = res.sra_backend_url;
});
$('backendUrlInput').addEventListener('change', () => {
  chrome.storage.local.set({ sra_backend_url: $('backendUrlInput').value.trim() });
});

// ── Diagnostics link ────────────────────────────────────────────────────
$('diagnosticsBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/diagnostics.html') });
});
