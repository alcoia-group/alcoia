/* session-report-state.js — the display vocabulary for the session report,
 * split out from session-report.js so it is importable by a real ES module
 * and therefore testable against state-engine.js's actual STATES without
 * loading the whole page (chrome.storage.local, document, the rendering
 * code) into a test environment.
 *
 * Keyed on the engine's actual vocabulary (state-engine.js's STATES) —
 * `focused`/`confused`/`zoning_out`/`overloaded` were the removed camera
 * classifier's names and nothing here has emitted them since that path was
 * deleted (see CLAUDE.md's migration note). session.stateDurations is built
 * by session-tracker.js's recordState(state.label), and state.label is
 * always one of these five, so every key below is reachable and nothing
 * else is. (ABSENT used to be a sixth key here; removed along with the
 * state itself once the audit confirmed nothing ever produced it — see
 * state-engine.js's own STATES comment.)
 *
 * Colours reference panel.css's dark-mode-aware tokens (session-report.html
 * loads panel.css, not overlay.css, so overlay.css's --alc-* custom
 * properties are not in scope there) where a named token exists for the
 * CLAUDE.md-decided hue: --sage-2 for on_pace, --warn for struggling.
 * skimming and drifting have no named token anywhere in the codebase —
 * overlay.css's own .sra-state-skimming/.sra-state-drifting rules use the
 * same literal hex inline rather than a custom property — so those two are
 * the literal hex here too, matching CLAUDE.md's decided values exactly.
 * drifting's colour applies whenever that state shows in a past session's
 * time-in-state bar — today that only ever happens because the reader
 * self-reported disengagement during it, not because it was passively
 * detected; see state-engine.js's own STATES comment.
 *
 * unknown has no hue decided in CLAUDE.md (only the four interruption-
 * earning states do), so it gets a neutral, non-alarming panel.css token
 * rather than a colour that implies a measurement. It must appear here
 * rather than being hidden or folded into another bucket: it is a valid,
 * correct, common answer (invariant 5), and a report that erases it would
 * be reporting something the engine didn't actually observe. */
export const STATE_COLORS = {
  on_pace: 'var(--sage-2)', skimming: '#5B7A99', struggling: 'var(--warn)',
  drifting: '#7E6E5A', unknown: 'var(--muted)',
};

export const STATE_LABELS = {
  on_pace: 'On Pace', skimming: 'Skimming', struggling: 'Struggling',
  drifting: 'Drifting', unknown: 'Unknown',
};
