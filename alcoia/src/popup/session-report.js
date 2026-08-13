import { STATE_COLORS, STATE_LABELS } from './session-report-state.js';

function dur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  return r > 0 ? `${m}m ${r}s` : `${m}m`;
}

function renderReport(session) {
  const totalMs = session.totalMs || (session.endedAt - session.startedAt) || 1;
  const totalStateMs = Object.values(session.stateDurations || {}).reduce((a, b) => a + b, 0) || totalMs;

  // State bar
  const segs = Object.entries(STATE_COLORS).map(([state, color]) => {
    const ms  = (session.stateDurations || {})[state] || 0;
    const pct = totalStateMs > 0 ? (ms / totalStateMs * 100).toFixed(1) : '0.0';
    return { state, color, pct: parseFloat(pct), ms };
  }).filter(s => s.pct > 0);

  const barHtml = segs.length
    ? segs.map(s => `<div class="state-seg" style="width:${s.pct}%;background:${s.color}" title="${STATE_LABELS[s.state]}: ${dur(s.ms)}"></div>`).join('')
    : '<div style="width:100%;background:#e0ddd8"></div>';

  const legHtml = segs.map(s =>
    `<div class="leg-item"><div class="leg-dot" style="background:${s.color}"></div>${STATE_LABELS[s.state]} ${s.pct}%</div>`
  ).join('');

  /* Signals. orchestrator.js's stateEngine.subscribe only calls
   * sessionTracker.recordSignal(type, subtype, evidence) for a signal
   * that actually reached the screen — type is state.label (one of the
   * six states above), subtype is decision.action ('ask'/'nudge').
   * question-card.js separately records answers as type: 'response',
   * subtype: 'correct'/'incorrect'/'dismissed' (response-signals.js). A
   * raw 'backtrack' or 'speed_mismatch' telemetry signal is never itself
   * pushed into session.signals — those only ever fold into a resulting
   * struggling/skimming state above — so filtering on those two type
   * strings, or on the removed 'confused'/'overloaded' subtype values,
   * always matched zero signals regardless of what actually happened in
   * the session. struggling and skimming both produce a shown question
   * with quoted evidence, which is what this section is for; a wrong
   * answer is the other half of "where the reading struggled". */
  const interesting = (session.signals || []).filter(s =>
    s.type === 'struggling' || s.type === 'skimming' ||
    (s.type === 'response' && s.subtype === 'incorrect')
  );
  const sigHtml = interesting.length
    ? interesting.map(s => {
        const bc = s.type === 'struggling' ? 'var(--warn)'
          : s.type === 'skimming' ? '#5B7A99' : 'var(--wrong)';
        const lab = s.type === 'response' ? 'answered incorrectly' : STATE_LABELS[s.type];
        const txt = s.text ? `<p class="sig-text">"${s.text.slice(0, 120)}${s.text.length > 120 ? '…' : ''}"</p>` : '';
        return `<div class="signal-item">
          <span class="sig-badge" style="background:color-mix(in srgb, ${bc} 15%, transparent);color:${bc};border:1px solid color-mix(in srgb, ${bc} 40%, transparent)">${lab}</span>
          ${txt}
        </div>`;
      }).join('')
    : '<p style="color:var(--muted);font-style:italic;font-size:12px">No struggle signals this session — great reading!</p>';

  const dateStr = session.startedAt ? new Date(session.startedAt).toLocaleString([], { dateStyle:'medium', timeStyle:'short' }) : '—';
  const pageTitle = (session.title || session.url || '').slice(0, 80);

  return `
    <p class="page-info">${pageTitle} &mdash; ${dateStr}</p>

    <div class="stat-grid">
      <div class="stat-card"><div class="stat-value">${dur(totalMs)}</div><div class="stat-label">Time on Page</div></div>
      <div class="stat-card"><div class="stat-value">${session.avgWpm || '—'}</div><div class="stat-label">Avg WPM</div></div>
      <div class="stat-card"><div class="stat-value">${session.struggleCount || 0}</div><div class="stat-label">Struggle Triggers</div></div>
      <div class="stat-card"><div class="stat-value">${session.backtrackCount || 0}</div><div class="stat-label">Scroll Backtracks</div></div>
    </div>

    <div class="sec-title">Cognitive State Distribution</div>
    <div class="state-bar">${barHtml}</div>
    <div class="state-legend">${legHtml || '<span style="color:var(--muted);font-style:italic;font-size:11px">No state data yet</span>'}</div>

    <div class="sec-title">Struggle Points</div>
    <div class="signal-list">${sigHtml}</div>
  `;
}

chrome.storage.local.get({ sra_sessions: [] }, ({ sra_sessions: sessions }) => {
  const picker  = document.getElementById('picker');
  const report  = document.getElementById('report');
  if (!sessions.length) return;

  sessions.slice(0, 10).forEach((s, i) => {
    const btn = document.createElement('button');
    btn.className = 'pick-btn' + (i === 0 ? ' active' : '');
    const d = s.startedAt ? new Date(s.startedAt) : new Date();
    btn.textContent = d.toLocaleDateString([], { month:'short', day:'numeric' }) + ' ' +
      d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    btn.onclick = () => {
      document.querySelectorAll('.pick-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      report.innerHTML = renderReport(s);
    };
    picker.appendChild(btn);
  });

  report.innerHTML = renderReport(sessions[0]);
});
