/* session-report-state.js — the display vocabulary for the session report,
 * split out from session-report.js so it is importable by a real ES module
 * and therefore testable against state-engine.js's actual STATES without
 * loading the whole page (chrome.storage.local, document, the rendering
 * code) into a test environment.
 *
 * Keyed on the engine's actual vocabulary (state-engine.js's STATES) —
 * `focused`/`confused`/`zoning_out`/`overloaded` were the removed camera
 * classifier's names and nothing here has emitted them since that path was
 * deleted (see the project notes' migration note). session.stateDurations is built
 * by session-tracker.js's recordState(state.label), and state.label is
 * always one of these six, so every key below is reachable and nothing
 * else is.
 *
 * Colours reference panel.css's dark-mode-aware tokens (session-report.html
 * loads panel.css, not overlay.css, so overlay.css's --alc-* custom
 * properties are not in scope there) where a named token exists for the
 * the project notes-decided hue: --sage-2 for on_pace, --warn for struggling.
 * skimming and drifting have no named token anywhere in the codebase —
 * overlay.css's own .sra-state-skimming/.sra-state-drifting rules use the
 * same literal hex inline rather than a custom property — so those two are
 * the literal hex here too, matching the project notes' decided values exactly.
 *
 * absent and unknown have no hue decided in the project notes (only the four
 * interruption-earning states do). Both are "nothing to report" states —
 * absent because the reader wasn't there, unknown because the signals
 * didn't agree — so both get a neutral, non-alarming panel.css token
 * rather than a colour that implies a measurement. unknown must appear
 * here rather than being hidden or folded into another bucket: it is a
 * valid, correct, common answer (invariant 5), and a report that erases it
 * would be reporting something the engine didn't actually observe. */
export const STATE_COLORS = {
  on_pace: 'var(--sage-2)', skimming: '#5B7A99', struggling: 'var(--warn)',
  drifting: '#7E6E5A', absent: 'var(--faint)', unknown: 'var(--muted)',
};

export const STATE_LABELS = {
  on_pace: 'On Pace', skimming: 'Skimming', struggling: 'Struggling',
  drifting: 'Drifting', absent: 'Absent', unknown: 'Unknown',
};
