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

  const stateDurations = { focused: 0, skimming: 0, confused: 0, zoning_out: 0, overloaded: 0 };
  const signals    = [];  // { type, subtype, text, timestamp }
  const wpmReadings = []; // { wpm, grade }

  let lastState   = 'focused';
  let lastStateAt = Date.now();

  function recordState(label) {
    if (!label) return;
    const now = Date.now();
    if (lastState && stateDurations[lastState] !== undefined) {
      stateDurations[lastState] += now - lastStateAt;
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
      confusionCount:     signals.filter(s => s.subtype === 'confused' || s.subtype === 'overloaded').length,
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

  return { recordState, recordSignal, recordWpm, save };
}
