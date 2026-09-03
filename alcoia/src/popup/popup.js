/* popup.js — the immediate-view popup (item 15a-1 split).
 *
 * Was a classic script; is now a real ES module (`<script type="module">`
 * in popup.html) so it can import session.js/entitlements.js directly, the
 * same way account.js/upgrade.js already do — session.js's own header
 * explains why background.js CANNOT import it (service worker, no dynamic
 * import()), but that constraint never applied to this file; it just never
 * had a reason to convert before. All the toggle/switch wiring that used to
 * live here moved to settings.js, which is the new, single place every
 * sra_* control is read and written.
 *
 * Two modes, chosen by presence of an active content script on the current
 * tab (content.js's existing synchronous `{type:'getState'}` handler,
 * content.js:1410 — no new content.js code needed):
 *   READING — the tab has alcoia running on it right now.
 *   HOME    — anything else: a new tab, an extension page, a page with no
 *             content script reachable (chrome://, a disallowed origin).
 */
import { createSessionManager } from '../shared/session.js';
import { createEntitlementsManager } from '../shared/entitlements.js';

const STATE_UI = {
  on_pace:    { name: 'On pace',      dot: 'live', why: 'Your pace matches the difficulty of this text.' },
  skimming:   { name: 'Skimming',     dot: 'live', why: 'Moving faster than this text usually takes to read.' },
  struggling: { name: 'Struggling',   dot: 'attn', why: 'Slower than your usual pace here, or going back over it.' },
  drifting:   { name: 'Drifting',     dot: 'attn', why: 'Movement on the page has stalled without you leaving it.' },
  absent:     { name: 'Away',         dot: '',     why: 'Nothing to read from — you are away from the page.' },
  unknown:    { name: 'Not sure yet', dot: '',     why: 'The signals do not agree. Nothing interrupts you on this.' },
};

const session = createSessionManager();
const entitlements = createEntitlementsManager({
  getSession: session.getSession,
  entitlementsUrl: self.ALCOIA_CONFIG.ENTITLEMENTS_URL,
});

document.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id);

  const assistantToggle = $('assistantToggle');
  const permBanner = $('permBanner');
  const permGrantBtn = $('permGrantBtn');
  const readingMode = $('readingMode');
  const homeMode = $('homeMode');

  // ── Master switch — mirrored in settings.html's Detection group. Both
  // write sra_enabled directly (no broadcast) and both listen for the other
  // writing it, via chrome.storage.onChanged. ──────────────────────────────
  chrome.storage.local.get({ sra_enabled: true, sra_dark_mode: false }, (res) => {
    assistantToggle.checked = res.sra_enabled !== false;
    document.body.classList.toggle('assistant-off', res.sra_enabled === false);
    document.body.classList.toggle('dark-mode', !!res.sra_dark_mode);
  });
  assistantToggle.addEventListener('change', () => {
    chrome.storage.local.set({ sra_enabled: assistantToggle.checked });
    document.body.classList.toggle('assistant-off', !assistantToggle.checked);
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.sra_enabled) {
      assistantToggle.checked = changes.sra_enabled.newValue !== false;
      document.body.classList.toggle('assistant-off', changes.sra_enabled.newValue === false);
    }
    if (changes.sra_dark_mode) {
      document.body.classList.toggle('dark-mode', !!changes.sra_dark_mode.newValue);
    }
  });

  // ── Host access (Firefox MV3 optional permissions) — unchanged from the
  // old popup.js, verbatim logic. ─────────────────────────────────────────
  function refreshHostPermission() {
    if (!permBanner || !chrome.permissions?.contains) return;
    try {
      chrome.permissions.contains({ origins: ['<all_urls>'] }, (granted) => {
        if (chrome.runtime.lastError) return;
        permBanner.hidden = !!granted;
        document.body.classList.toggle('no-host-access', !granted);
      });
    } catch (e) { /* API absent — assume granted, as on Chrome */ }
  }
  permGrantBtn?.addEventListener('click', () => {
    chrome.permissions.request({ origins: ['<all_urls>'] }, () => {
      if (chrome.runtime.lastError) return;
      refreshHostPermission();
    });
  });
  refreshHostPermission();

  const openPage = (id, path) => $(id)?.addEventListener('click',
    () => chrome.tabs.create({ url: chrome.runtime.getURL(path) }));

  openPage('settingsBtnReading', 'src/popup/settings.html');
  openPage('settingsBtnHome',    'src/popup/settings.html');

  // ═══════════════════════ READING MODE ═══════════════════════════════
  function paintPage(tab) {
    const favicon = $('pageFavicon');
    const title = $('pageTitle');
    if (favicon) {
      favicon.style.visibility = tab.favIconUrl ? 'visible' : 'hidden';
      if (tab.favIconUrl) favicon.src = tab.favIconUrl;
    }
    if (title) {
      let label = tab.title || '';
      try { label = label || new URL(tab.url).hostname; } catch (e) { /* not a normal URL */ }
      title.textContent = label || 'This page';
    }
  }

  function setReadingState(raw) {
    const ui = STATE_UI[raw] || STATE_UI.unknown;
    const stateDot = $('stateDot'), stateName = $('stateName'), stateWhy = $('stateWhy');
    if (!stateDot) return;
    stateName.textContent = ui.name;
    stateWhy.textContent = ui.why;
    stateDot.className = 'state-dot' + (ui.dot ? ' ' + ui.dot : '');
  }

  function sendToTab(tabId, msg, cb) {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) { cb && cb(null, chrome.runtime.lastError); return; }
      cb && cb(resp);
    });
  }

  function wireReadingActions(tab) {
    // Pause: reuses the existing persistent snooze mechanism (snooze.js /
    // content.js's snoozeReminders), relabeled. Not a true in-memory
    // session-only pause — that concept does not exist in this codebase
    // today, and building one meant a new content.js message handler,
    // which this pass does not touch. Flagged in the task report.
    const pauseBtn = $('pauseBtn');
    pauseBtn?.addEventListener('click', () => {
      pauseBtn.disabled = true;
      sendToTab(tab.id, { action: 'snoozeReminders', optionId: '15m' }, () => {
        pauseBtn.disabled = false;
        window.close();
      });
    });

    // Self-report: the on-page button (ui-controller.js's
    // ensureSelfReportTrigger) is the real affordance; content.js exposes no
    // chrome.runtime.onMessage handler to fire the card remotely (only the
    // Alt+C keydown inside content.js itself). Focusing the tab and closing
    // the popup is the honest substitute without touching content.js.
    const selfReportBtn = $('selfReportBtn');
    selfReportBtn?.addEventListener('click', () => {
      chrome.tabs.update(tab.id, { active: true });
      chrome.windows?.update?.(tab.windowId, { focused: true });
      window.close();
    });
  }

  function enterReadingMode(tab) {
    readingMode.hidden = false;
    homeMode.hidden = true;
    paintPage(tab);
    wireReadingActions(tab);
    sendToTab(tab.id, { type: 'getState' }, (resp) => {
      if (resp?.state) setReadingState(resp.state);
    });
    const poll = setInterval(() => {
      if (readingMode.hidden) { clearInterval(poll); return; }
      sendToTab(tab.id, { type: 'getState' }, (resp, err) => {
        if (err) { clearInterval(poll); return; }
        if (resp?.state) setReadingState(resp.state);
      });
    }, 2500);
  }

  // ═══════════════════════ HOME MODE ═══════════════════════════════════
  async function refreshAccountStatus() {
    const current = await session.getSession();
    const signedOutEl = $('accountSignedOut');
    const signedInEl = $('accountSignedIn');
    const signInBtn = $('signInBtn');
    const signOutBtnEl = $('signOutBtn');
    if (signedOutEl) signedOutEl.hidden = !!current;
    if (signedInEl) signedInEl.hidden = !current;
    if (signInBtn) signInBtn.hidden = !!current;
    if (signOutBtnEl) signOutBtnEl.hidden = !current;
    if (current) { const emailEl = $('accountEmail'); if (emailEl) emailEl.textContent = current.email || ''; }
  }

  openPage('signInBtn', 'src/popup/account.html');
  $('signOutBtn')?.addEventListener('click', async () => {
    // One click used to sign out immediately — too easy to hit by accident
    // in a compact popup. Nothing local is deleted by signing out (CLAUDE.md:
    // notes/highlights/quizzes stay on-device either way), but it does drop
    // paid-feature access until signing back in, which is worth a pause.
    if (!confirm('Sign out of alcoia? You can sign back in any time — nothing on this device is deleted.')) return;
    await session.clearSession();
    refreshAccountStatus();
  });

  async function refreshUpgradeBanner() {
    const banner = $('upgradeBanner');
    if (!banner) return;
    // Reuses entitlements.js's hasFeature() — never a bare tier read
    // (CLAUDE.md: "the client never decides entitlement"; entitlements.js's
    // own header: "everything goes through hasFeature()"). 'own_documents'
    // is the same feature name upgrade.js itself checks.
    const entitled = await entitlements.hasFeature('own_documents');
    banner.hidden = entitled;
  }

  openPage('assignmentsBtn',   'src/popup/assignments.html');
  openPage('notesBtn',         'src/popup/notes.html');
  openPage('sessionReportBtn', 'src/popup/session-report.html');
  openPage('exportBtn',        'src/popup/export.html');
  openPage('joinClassBtn',     'src/popup/join-class.html');
  openPage('upgradeBtn',       'src/popup/upgrade.html');

  // Quiz (restored — see this file's git history / the 15a-1 report for
  // the mistake this corrects): quiz.html requires a ?key= identifying
  // which document's quiz to show (quiz.js's boot(): "No quiz to show" is
  // the ENTIRE result of opening it bare) — there is no generic quiz
  // browser to link to. This has to stay the same coverage-gated
  // generate-and-open flow the old popup used: checkQuizCoverage decides
  // whether the active tab has enough tracked reading (coverage-gate.js's
  // evaluate(), the same threshold the end-of-reading offer itself reads —
  // CLAUDE.md, "The quiz — decided"), and startQuiz is what actually
  // generates one and navigates content.js's own tab to quiz.html?key=...
  // on success. Gated on the tab active when the popup opened, which in
  // home mode is usually not a reading page — greyed out is the accurate,
  // not broken, result of that.
  const quizBtn = $('quizBtn');
  const quizGateNote = $('quizGateNote');
  let quizGateTab = null;

  function refreshQuizGate() {
    if (!quizBtn) return;
    if (!quizGateTab) {
      quizBtn.disabled = true;
      if (quizGateNote) {
        quizGateNote.hidden = false;
        quizGateNote.textContent = 'not enough reading tracked on this page yet';
      }
      return;
    }
    sendToTab(quizGateTab.id, { action: 'checkQuizCoverage' }, (resp, err) => {
      const ready = !err && resp && resp.ready === true;
      quizBtn.disabled = !ready;
      if (quizGateNote) {
        quizGateNote.hidden = ready;
        quizGateNote.textContent = (!err && resp && resp.reason)
          || 'not enough reading tracked on this page yet';
      }
    });
  }

  quizBtn?.addEventListener('click', () => {
    if (quizBtn.disabled || !quizGateTab) return;
    const idle = quizBtn.querySelector('.entry-btn-name')?.textContent;
    quizBtn.disabled = true;
    const nameEl = quizBtn.querySelector('.entry-btn-name');
    if (nameEl) nameEl.textContent = 'Preparing…';
    sendToTab(quizGateTab.id, { action: 'startQuiz' }, (resp, err) => {
      if (!err && resp && resp.started) { window.close(); return; }
      quizBtn.disabled = false;
      if (nameEl && idle) nameEl.textContent = idle;
      if (quizGateNote) quizGateNote.textContent = "Couldn't prepare a quiz right now — try again in a moment.";
    });
  });

  // Highlights: preserves the sidebar-first behavior with a full-page
  // fallback when no content script is reachable on the active tab.
  $('highlightsBtn')?.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs?.[0];
      if (!tab) { chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/highlights.html') }); return; }
      sendToTab(tab.id, { action: 'openHighlightsSidebar' }, (resp, err) => {
        if (err) chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/highlights.html') });
        window.close();
      });
    });
  });

  function enterHomeMode(tab) {
    readingMode.hidden = true;
    homeMode.hidden = false;
    refreshAccountStatus();
    refreshUpgradeBanner();
    quizGateTab = tab || null;
    refreshQuizGate();
  }

  // ═══════════════════════ Mode detection ═══════════════════════════════
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs?.[0];
    if (!tab) { enterHomeMode(); return; }
    chrome.tabs.sendMessage(tab.id, { type: 'getState' }, (resp) => {
      if (!chrome.runtime.lastError && resp && resp.state) {
        enterReadingMode(tab);
      } else {
        enterHomeMode(tab);
      }
    });
  });
});

// ── Logo (packaged path differs from the relative one in the markup) ───────
try {
  const logo = document.getElementById('sra-logo-img');
  const logoDark = document.getElementById('sra-logo-img-dark');
  if (logo) logo.src = chrome.runtime.getURL('assets/alcoia-wordmark.png');
  if (logoDark) logoDark.src = chrome.runtime.getURL('assets/alcoia-wordmark-white.png');
  const cj = document.getElementById('cjLogo');
  const cjDark = document.getElementById('cjLogoDark');
  if (cj) cj.src = chrome.runtime.getURL('assets/logo-cj-black.png');
  if (cjDark) cjDark.src = chrome.runtime.getURL('assets/logo-cj-white.png');
} catch (e) { /* not in an extension context */ }
