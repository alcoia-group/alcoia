/* popup.js — the toolbar panel.
 *
 * State vocabulary. The engine emits on_pace / skimming / struggling /
 * drifting / absent / unknown. This panel used to display the older
 * focused / confused / zoning_out / overloaded names, so the chips never
 * lit up — nothing ever sent a label that matched an element id. STATE_UI
 * below is the single place the names, their wording and their dot colour
 * are defined, and LEGACY_STATES maps the old names onto the new ones for
 * anything still speaking the old vocabulary.
 */

const STATE_UI = {
  on_pace:    { name: 'On pace',      dot: 'live', why: 'Your pace matches the difficulty of this text.' },
  skimming:   { name: 'Skimming',     dot: 'live', why: 'Moving faster than this text usually takes to read.' },
  struggling: { name: 'Struggling',   dot: 'attn', why: 'Slower than your usual pace here, or going back over it.' },
  drifting:   { name: 'Drifting',     dot: 'attn', why: 'Movement on the page has stalled without you leaving it.' },
  absent:     { name: 'Away',         dot: '',     why: 'Nothing to read from — you are away from the page.' },
  unknown:    { name: 'Not sure yet', dot: '',     why: 'The signals do not agree. Nothing interrupts you on this.' },
};

/* Older labels that may still arrive from the simulate path or a stale
 * storage value. Kept as a translation layer, not as a vocabulary. */
const LEGACY_STATES = {
  focused: 'on_pace', confused: 'struggling', overloaded: 'struggling',
  zoning_out: 'drifting', skimming: 'skimming',
};

const canonicalState = (s) => (STATE_UI[s] ? s : LEGACY_STATES[s] || null);

document.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id);

  // ── Tabs ────────────────────────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === target));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + target));
    });
  });

  // ── Elements ────────────────────────────────────────────────────────────
  const assistantToggle     = $('assistantToggle');
  const selToggle           = $('selToggle');
  const highlightToggle     = $('highlightToggle');
  const highlightColorToggle      = $('highlightColorToggle');
  const highlightPersistToggle    = $('highlightPersistToggle');
  const highlightSummarizeToggle  = $('highlightSummarizeToggle');
  const autohideToggle      = $('autohideToggle');
  const autohideTimeout     = $('autohideTimeout');
  const timeoutRow          = $('timeoutRow');
  const pinDefaultToggle    = $('pinDefaultToggle');
  const debugTogglePopup    = $('debugTogglePopup');
  const comprehensionToggle = $('comprehensionToggle');
  const ttsToggle           = $('ttsToggle');
  const focusRulerToggle    = $('focusRulerToggle');
  const dyslexiaToggle      = $('dyslexiaToggle');
  const dyslexiaOptions     = $('dyslexiaOptions');
  const bionicToggle        = $('bionicToggle');
  const dyslexiaColorSelect = $('dyslexiaColorSelect');
  // Item 33: the backend URL field itself moved to the diagnostics page
  // (developer-only, sra_debug-gated) — a reader editing it in the main
  // popup could only break their own install once a real origin is
  // configured. This file still needs the current value to include in every
  // settings broadcast to content.js, so it reads it once from storage
  // (below) rather than holding it in a removed input's .value.
  let currentBackendUrl = self.ALCOIA_CONFIG.SUMMARIZE_URL;
  const darkModeToggle      = $('darkModeToggle');
  const pdfTakeoverToggle   = $('pdfTakeoverToggle');
  const webPdfTakeoverToggle = $('webPdfTakeoverToggle');

  const stateDot     = $('stateDot');
  const stateName    = $('stateName');
  const stateWhy     = $('stateWhy');
  const signalChip   = $('signalChip');
  const signalStatus = $('signalStatus');

  // ── Settings ────────────────────────────────────────────────────────────
  const DEFAULTS = {
    // Defined in src/shared/config.js, loaded before this file — see
    // popup.html. One place for the shipped origin; overriding this field
    // (below, in the Settings panel) is the documented way to point a dev
    // build at a local backend without editing source or the manifest.
    sra_backend_url: self.ALCOIA_CONFIG.SUMMARIZE_URL,
    sra_selection: true, sra_highlight_para: true,
    // Item 26: two independent controls rather than one four-way mode —
    // colour is a free, client-only display preference; summarising spends
    // an assist, so it defaults off regardless of what colour defaults to.
    sra_highlight_color: true, sra_highlight_summarize: false,
    // On by default — losing a highlight silently on navigation would be
    // the surprising behaviour, not keeping it.
    sra_highlight_persist: true,
    sra_autohide: false, sra_autohide_timeout: 12,
    sra_pin_default: false, sra_debug: false, sra_enabled: true,
    sra_comprehension: true, sra_current_state: '',
    sra_tts: false, sra_focus_ruler: false,
    sra_dyslexia: false, sra_dyslexia_color: 'rgba(255,243,180,0.12)', sra_bionic: false,
    sra_dark_mode: false, sra_active_persona: '',
    // Item 29: the escape hatch. background.js reads this directly from
    // storage at redirect time — it is not part of the content.js settings
    // broadcast below, since content.js never touches PDF/PPTX redirection.
    sra_pdf_takeover: true,
    // Item 31: opt-in, off by default — a separate, larger trust ask than
    // the local-file toggle above, since it applies to any PDF a website
    // links to, not just files already on the reader's own computer.
    sra_web_pdf_takeover: false,
  };

  chrome.storage.local.get(DEFAULTS, (res) => {
    currentBackendUrl            = res.sra_backend_url;
    selToggle.checked           = res.sra_selection !== false;
    highlightToggle.checked     = res.sra_highlight_para !== false;
    highlightColorToggle.checked     = res.sra_highlight_color !== false;
    highlightPersistToggle.checked   = res.sra_highlight_persist !== false;
    highlightSummarizeToggle.checked = !!res.sra_highlight_summarize;
    autohideToggle.checked      = !!res.sra_autohide;
    autohideTimeout.value       = res.sra_autohide_timeout;
    timeoutRow.style.display    = res.sra_autohide ? 'flex' : 'none';
    pinDefaultToggle.checked    = !!res.sra_pin_default;
    syncPinAutohideExclusivity();
    debugTogglePopup.checked    = !!res.sra_debug;
    comprehensionToggle.checked = res.sra_comprehension !== false;
    assistantToggle.checked     = res.sra_enabled !== false;
    document.body.classList.toggle('assistant-off', res.sra_enabled === false);
    ttsToggle.checked           = !!res.sra_tts;
    focusRulerToggle.checked    = !!res.sra_focus_ruler;
    dyslexiaToggle.checked      = !!res.sra_dyslexia;
    dyslexiaOptions.style.display = res.sra_dyslexia ? 'block' : 'none';
    bionicToggle.checked        = !!res.sra_bionic;
    dyslexiaColorSelect.value   = res.sra_dyslexia_color || '';

    darkModeToggle.checked = !!res.sra_dark_mode;
    document.body.classList.toggle('dark-mode', !!res.sra_dark_mode);

    pdfTakeoverToggle.checked = res.sra_pdf_takeover !== false;
    webPdfTakeoverToggle.checked = !!res.sra_web_pdf_takeover;

    if (res.sra_active_persona) {
      document.querySelectorAll('.mode-btn').forEach((b) =>
        b.classList.toggle('active', b.dataset.persona === res.sra_active_persona));
    }

    setSignalChip(res.sra_comprehension !== false);
    if (res.sra_current_state) setReadingState(res.sra_current_state);
  });

  // ── Status ──────────────────────────────────────────────────────────────
  function setSignalChip(on) {
    signalChip.className = 'src-chip' + (on ? ' on' : '');
    signalStatus.textContent = on ? 'Noticing' : 'Not noticing';
  }

  /* Paint the fused estimate. An unrecognised label is shown as unknown
   * rather than guessed at — inventing a state here would be the UI telling
   * the reader something the engine never said. */
  function setReadingState(raw) {
    const key = canonicalState(raw);
    const ui  = STATE_UI[key] || STATE_UI.unknown;

    stateName.textContent = ui.name;
    stateWhy.textContent  = ui.why;
    stateDot.className    = 'state-dot' + (ui.dot ? ' ' + ui.dot : '');

    Object.keys(STATE_UI).forEach((s) => {
      const el = $('chip-' + s);
      if (!el) return;
      el.className = 'chip' + (s === key ? ' on on-' + s : '');
    });
  }

  // ── Live state while the panel is open ──────────────────────────────────
  setInterval(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs?.[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, { type: 'getState' }, (resp) => {
        if (chrome.runtime.lastError) return;
        if (resp?.state) setReadingState(resp.state);
      });
    });
  }, 2500);

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.sra_current_state?.newValue) setReadingState(changes.sra_current_state.newValue);
  });

  // ── Save & broadcast ────────────────────────────────────────────────────
  function saveAndBroadcast() {
    const s = {
      // Read-only here now (item 33) — the diagnostics page owns writing
      // this. Included so every settings broadcast still carries the
      // current value through to content.js's live setting.
      sra_backend_url:      currentBackendUrl,
      sra_selection:        selToggle.checked,
      sra_highlight_para:   highlightToggle.checked,
      sra_highlight_color:      highlightColorToggle.checked,
      sra_highlight_persist:    highlightPersistToggle.checked,
      sra_highlight_summarize:  highlightSummarizeToggle.checked,
      sra_autohide:         autohideToggle.checked,
      sra_autohide_timeout: Number(autohideTimeout.value) || 12,
      sra_pin_default:      pinDefaultToggle.checked,
      sra_debug:            debugTogglePopup.checked,
      sra_enabled:          assistantToggle.checked,
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
    setSignalChip(s.sra_comprehension);

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs?.[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'settings',
        backendUrl: s.sra_backend_url,
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
  }

  // ── Toggles ─────────────────────────────────────────────────────────────
  /* The master switch. Writing the key is enough — every open tab listens for
   * it via chrome.storage.onChanged, which a settings broadcast to the active
   * tab would miss. */
  assistantToggle.addEventListener('change', () => {
    chrome.storage.local.set({ sra_enabled: assistantToggle.checked });
    document.body.classList.toggle('assistant-off', !assistantToggle.checked);
  });
  // Item 29: read directly by background.js's redirect listener, not by any
  // content script — a plain storage write is enough, same as the master
  // switch above. No broadcast to a content script is needed or possible:
  // the effect is on the *next* navigation, not the current tab.
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
  // Item 34: "keep cards until I close them" and "clear cards automatically"
  // are opposite intentions. Both could previously be turned on at once,
  // which was meaningless — ui-controller.js's resetAutohide() already
  // checked `root.dataset.pinned === 'true'` before arming a timeout, so
  // pin already won structurally in code; the popup just never showed that.
  // Made explicit here: turning "keep" on forces "clear automatically" off
  // and disables it, rather than leaving a reader looking at two switches
  // that silently disagree.
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
  // saved from when it was on — ask once, default to keeping them. Turning
  // it on needs no such check: it only changes what happens to highlights
  // made from here on, nothing retroactive.
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
   debugTogglePopup,
   comprehensionToggle, ttsToggle, focusRulerToggle,
   bionicToggle, darkModeToggle]
    .forEach((el) => el.addEventListener('change', saveAndBroadcast));
  [autohideTimeout, dyslexiaColorSelect]
    .forEach((el) => el.addEventListener('change', saveAndBroadcast));

  // ── Tab messaging ───────────────────────────────────────────────────────
  function sendToTab(msg, cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs?.[0]) { cb && cb(null); return; }
      chrome.tabs.sendMessage(tabs[0].id, msg, (resp) => {
        if (chrome.runtime.lastError) { cb && cb(null, chrome.runtime.lastError); return; }
        cb && cb(resp);
      });
    });
  }

  /* Buttons that just poke the content script and close. `busy` label is
   * restored on failure so a page without a content script does not leave a
   * button stuck saying "Opening…". */
  function wireTabAction(id, msg, busyLabel) {
    const btn = $(id);
    if (!btn) return;
    const idle = btn.textContent;
    btn.addEventListener('click', () => {
      btn.disabled = true;
      if (busyLabel) btn.textContent = busyLabel;
      sendToTab(msg, (resp, err) => {
        btn.disabled = false;
        btn.textContent = idle;
        if (err) return;
        window.close();
      });
    });
  }

  wireTabAction('pageSummaryBtn', { type: 'pageSummary' },      'Reading the page…');
  wireTabAction('recallBtn',      { action: 'sessionRecall' },  'Opening…');
  wireTabAction('receiptBtn',     { action: 'showReceipt' },    'Opening…');

  // ── Pages ───────────────────────────────────────────────────────────────
  const openPage = (id, path) => $(id)?.addEventListener('click',
    () => chrome.tabs.create({ url: chrome.runtime.getURL(path) }));

  openPage('notesBtn',          'src/popup/notes.html');
  openPage('sessionReportBtn',  'src/popup/session-report.html');
  // Opens as an in-page sidebar on the active tab rather than a new page —
  // the full standalone page (src/popup/highlights.html) is still one click
  // away via the sidebar's own Expand button. Falls back to that page
  // directly when there is no content script on the active tab to ask
  // (e.g. a chrome:// page), the one case a sidebar cannot exist at all.
  $('viewHighlightsBtn')?.addEventListener('click', () => {
    sendToTab({ action: 'openHighlightsSidebar' }, (resp, err) => {
      if (err) chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/highlights.html') });
      window.close();
    });
  });
  openPage('exportBtn',         'src/popup/export.html');
  openPage('upgradeBtn',        'src/popup/upgrade.html');
  openPage('diagnosticsBtn',    'src/popup/diagnostics.html');
  openPage('signInBtn',         'src/popup/account.html');
  openPage('joinClassBtn',      'src/popup/join-class.html');
  openPage('assignmentsBtn',    'src/popup/assignments.html');

  // ── Account status (item S3) ─────────────────────────────────────────
  // popup.js is a classic script, not an ES module (see
  // src/shared/session.js's own header for why that file — the real,
  // tested definition of "is there a valid session right now" — cannot be
  // imported here). This duplicates only the minimal read+expiry check,
  // the same way this file already reads every other sra_* key straight
  // out of storage with no shared module. Never treats mere PRESENCE of
  // sra_session as signed-in — an expired entry reads as signed-out here
  // too, same as session.js's own getSession().
  function refreshAccountStatus() {
    chrome.storage.local.get({ sra_session: null }, (res) => {
      const s = res.sra_session;
      const valid = !!(s && typeof s.token === 'string' && s.token
        && (typeof s.expiresAt !== 'number' || s.expiresAt > Date.now()));
      const signedOutEl = $('accountSignedOut');
      const signedInEl  = $('accountSignedIn');
      if (signedOutEl) signedOutEl.hidden = valid;
      if (signedInEl)  signedInEl.hidden  = !valid;
      if (valid) { const emailEl = $('accountEmail'); if (emailEl) emailEl.textContent = s.email || ''; }
    });
  }
  refreshAccountStatus();

  $('signOutBtn')?.addEventListener('click', () => {
    chrome.storage.local.remove('sra_session', refreshAccountStatus);
  });

  /* ── Quiz gate ─────────────────────────────────────────────────────────
   * Reads the exact same function (content.js's checkQuizCoverage, which
   * calls coverage-gate.js's evaluate()) that the end-of-reading offer
   * uses — if this diverged from that, the overlay could say ready while
   * this button said no (CLAUDE.md, "The quiz — decided"). Disabled with
   * the stated reason rather than a silent no-op below threshold. */
  const quizBtn = $('quizBtn');
  const quizGateNote = $('quizGateNote');

  function refreshQuizGate() {
    sendToTab({ action: 'checkQuizCoverage' }, (resp, err) => {
      if (!quizBtn || !quizGateNote) return;
      const ready = !err && resp && resp.ready === true;
      quizBtn.disabled = !ready;
      quizGateNote.textContent = (!err && resp && resp.reason)
        || 'not enough reading tracked on this page yet';
    });
  }
  refreshQuizGate();

  // Generation (selecting passages, the one server call) happens in
  // content.js via runQuiz(), reached here through the startQuiz message —
  // not a direct chrome.tabs.create — because content.js is what opens the
  // quiz tab once a quiz actually exists to show, and popup.js has no
  // passage data of its own to hand it.
  quizBtn?.addEventListener('click', () => {
    if (quizBtn.disabled) return;
    const idle = quizBtn.textContent;
    quizBtn.disabled = true;
    quizBtn.textContent = 'Preparing…';
    sendToTab({ action: 'startQuiz' }, (resp, err) => {
      if (!err && resp && resp.started) { window.close(); return; }
      quizBtn.disabled = false;
      quizBtn.textContent = idle;
      if (quizGateNote) quizGateNote.textContent = "Couldn't prepare a quiz right now — try again in a moment.";
    });
  });

  /* ── Snooze (item 18) ─────────────────────────────────────────────────
   * Labels/ids only — the actual duration math (SNOOZE_OPTIONS in
   * snooze.js, including "rest of today") stays canonical in content.js's
   * context and is resolved there from the id, not recomputed here. popup.js
   * is a classic script, not a module, so it can't import snooze.js
   * directly the way question-card.js does. */
  const SNOOZE_DISPLAY_OPTIONS = [
    { id: '15m', label: '15 minutes' },
    { id: '1h', label: '1 hour' },
    { id: 'today', label: 'Rest of today' },
  ];
  const snoozeActive = $('snoozeActive');
  const snoozeInactive = $('snoozeInactive');
  const snoozeActiveNote = $('snoozeActiveNote');
  const snoozeOptionsEl = $('snoozeOptions');

  function renderSnoozeStatus(resp) {
    if (!snoozeActive || !snoozeInactive) return;
    const active = !!(resp && resp.active);
    snoozeActive.hidden = !active;
    snoozeInactive.hidden = active;
    if (active && snoozeActiveNote) {
      const until = new Date(resp.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      snoozeActiveNote.textContent = `Snoozed until ${until}. Detection keeps running in the background.`;
    }
  }

  function refreshSnoozeStatus() {
    sendToTab({ action: 'getSnoozeStatus' }, (resp, err) => renderSnoozeStatus(err ? null : resp));
  }

  if (snoozeOptionsEl) {
    for (const opt of SNOOZE_DISPLAY_OPTIONS) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost';
      btn.textContent = opt.label;
      btn.addEventListener('click', () => {
        btn.disabled = true;
        sendToTab({ action: 'snoozeReminders', optionId: opt.id }, (resp, err) => {
          btn.disabled = false;
          if (!err && resp && resp.status === 'ok') refreshSnoozeStatus();
        });
      });
      snoozeOptionsEl.appendChild(btn);
    }
  }

  $('cancelSnoozeBtn')?.addEventListener('click', () => {
    sendToTab({ action: 'cancelSnooze' }, () => refreshSnoozeStatus());
  });

  refreshSnoozeStatus();

  // ── Reading speed ──────────────────────────────────────────────────────
  const readingCalBtn = $('readingCalBtn');
  readingCalBtn.addEventListener('click', () => {
    readingCalBtn.disabled = true;
    readingCalBtn.textContent = 'Measuring…';
    sendToTab({ type: 'startReadingCalibration' }, (resp, err) => {
      readingCalBtn.disabled = false;
      readingCalBtn.textContent = 'Measure my reading speed';
      if (err) return;
      window.close();
    });
  });

  /* ── Host access ──────────────────────────────────────────────────────
   * Chrome grants host permissions at install. Firefox MV3 treats them as
   * optional: the extension is installed but cannot read any page until the
   * reader says so. Without this the extension would appear installed and
   * do nothing, with no explanation anywhere. `permissions.request()` has to
   * be called from a user gesture, which is why it lives on a click. */
  const permBanner = $('permBanner');
  const permGrantBtn = $('permGrantBtn');

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

  // ── Reading modes ───────────────────────────────────────────────────────
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

  // Item 33: the state simulator moved to the diagnostics page
  // (developer-only, sra_debug-gated) — a reader clicking "struggling" in
  // the main popup gets an interruption they did not earn and reasonably
  // concludes detection is broken. The mechanism itself (runSimulatedState()
  // in content.js, the simulateState message, and the Alt+1–5 keyboard
  // shortcuts) is untouched; only this popup's buttons are gone.
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
