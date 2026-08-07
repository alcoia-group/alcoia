/* session-tracker.js
   Tracks cognitive state distribution, comprehension signals, and WPM per page session.
   Persists completed sessions (>30s) to chrome.storage.local for the session report page.
*/

const MAX_SESSIONS  = 20;
const MIN_SESSION_MS = 30000;

export function createSessionTracker() {
  const startedAt = Date.now();
  const url   = window.location.href;
  const title = document.title || window.location.hostname;

  // Keyed by whatever the engine emits. It used to be a fixed object literal
  // with the pre-P1 label set, so after the rename every lookup was undefined
  // and no duration was ever accumulated — the guard below silently skipped
  // every state. Open map, so a future rename cannot reintroduce that.
  const stateDurations = Object.create(null);
  const signals    = [];  // { type, subtype, text, timestamp }
  const wpmReadings = []; // { wpm, grade }

  let lastState   = 'unknown';
  let lastStateAt = Date.now();

  function recordState(label) {
    if (!label) return;
    const now = Date.now();
    if (lastState) {
      stateDurations[lastState] = (stateDurations[lastState] || 0) + (now - lastStateAt);
    }
    lastState   = label;
    lastStateAt = now;
  }

  function recordSignal(type, subtype, text) {
    signals.push({
      type, subtype: subtype || '',
      text: (text || '').slice(0, 150),
      timestamp: Date.now(),
    });
  }

  function recordWpm(wpm, grade) {
    if (!wpm || wpm < 20 || wpm > 1200) return;
    wpmReadings.push({ wpm, grade });
    if (wpmReadings.length > 100) wpmReadings.shift();
  }

  async function save() {
    const now = Date.now();
    const totalMs = now - startedAt;
    if (totalMs < MIN_SESSION_MS) return;

    recordState(lastState); // flush remaining duration of current state

    const avgWpm = wpmReadings.length > 0
      ? Math.round(wpmReadings.reduce((a, r) => a + r.wpm, 0) / wpmReadings.length)
      : null;

    const entry = {
      url, title, startedAt, endedAt: now, totalMs,
      stateDurations: { ...stateDurations },
      signals: signals.slice(-30),
      avgWpm,
      struggleCount:      signals.filter(s => s.type === 'struggling').length,
      backtrackCount:     signals.filter(s => s.type  === 'backtrack').length,
      speedMismatchCount: signals.filter(s => s.type  === 'speed_mismatch').length,
    };

    return new Promise(resolve => {
      chrome.storage.local.get({ sra_sessions: [] }, ({ sra_sessions: sessions }) => {
        sessions.unshift(entry);
        if (sessions.length > MAX_SESSIONS) sessions.length = MAX_SESSIONS;
        chrome.storage.local.set({ sra_sessions: sessions }, resolve);
      });
    });
  }

  function snapshot() {
    // Flush the in-progress state so a receipt taken mid-session is accurate.
    recordState(lastState);
    return {
      url, title, startedAt,
      durationMs: Date.now() - startedAt,
      stateDurations: { ...stateDurations },
      signals: signals.slice(),
    };
  }

  return { recordState, recordSignal, recordWpm, save, snapshot };
}
