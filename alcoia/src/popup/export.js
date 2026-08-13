function pad2(n) { return String(n).padStart(2, '0'); }
function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fmtDuration(ms) {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s/60)}m ${s%60}s`;
}

function buildMarkdown(notes, highlights, sessions) {
  const lines = [];
  const now   = fmtDate(Date.now());

  lines.push(`# alcoia Reading Annotations`);
  lines.push(`> Exported ${now}\n`);

  // ── Notes ──────────────────────────────────────────────────────────────
  const noteList = (notes || []).slice(0, 200);
  lines.push(`## Notes (${noteList.length})`);
  if (!noteList.length) {
    lines.push('_No notes saved yet._\n');
  } else {
    noteList.forEach(n => {
      const url   = n.meta?.url   || '';
      const title = n.meta?.title || url || 'Unknown page';
      lines.push(`### ${title}`);
      if (url) lines.push(`> Source: ${url}`);
      lines.push(`> Saved: ${fmtDate(n.id)}\n`);
      lines.push(n.text || '');
      lines.push('');
    });
  }

  // ── Colour highlights ──────────────────────────────────────────────────
  const COLOR_EMOJI = { yellow: '🟡', green: '🟢', blue: '🔵', pink: '🩷', orange: '🟠' };
  const allHl = [];
  for (const [urlKey, entries] of Object.entries(highlights || {})) {
    (entries || []).forEach(e => allHl.push({ ...e, urlKey }));
  }
  allHl.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  lines.push(`## Colour Highlights (${allHl.length})`);
  if (!allHl.length) {
    lines.push('_No highlights yet. Hold Ctrl and drag to select text on any page._\n');
  } else {
    // Group by page
    const byUrl = {};
    allHl.forEach(h => { (byUrl[h.urlKey] = byUrl[h.urlKey] || []).push(h); });
    for (const [urlKey, entries] of Object.entries(byUrl)) {
      lines.push(`### ${entries[0]?.title || urlKey}`);
      lines.push(`> ${entries[0]?.url || urlKey}\n`);
      entries.forEach(h => {
        const emoji = COLOR_EMOJI[h.colorKey] || '•';
        lines.push(`${emoji} "${(h.text || '').slice(0, 300)}"`);
        lines.push(`   _${fmtDate(h.timestamp)}_\n`);
      });
    }
  }

  // ── Session history ────────────────────────────────────────────────────
  const sessionList = (sessions || []).slice(0, 30);
  lines.push(`## Session History (${sessionList.length} sessions)`);
  if (!sessionList.length) {
    lines.push('_No sessions recorded yet._\n');
  } else {
    sessionList.forEach(s => {
      const title = s.title || s.url || 'Unknown';
      const date  = fmtDate(s.startedAt);
      lines.push(`### ${title}`);
      lines.push(`> ${s.url || ''}`);
      lines.push(`> ${date} · ${fmtDuration(s.duration)}\n`);

      if (s.states) {
        const totalMs = Object.values(s.states).reduce((a, b) => a + b, 0) || 1;
        const stateParts = Object.entries(s.states)
          .filter(([, ms]) => ms > 0)
          .sort(([,a],[,b]) => b - a)
          .map(([k, ms]) => `${k} ${Math.round(ms/totalMs*100)}%`)
          .join(' · ');
        if (stateParts) lines.push(`**States:** ${stateParts}`);
      }
      if (s.wpmReadings?.length) {
        const avg = Math.round(s.wpmReadings.reduce((a,b)=>a+b,0)/s.wpmReadings.length);
        lines.push(`**Avg WPM:** ${avg}`);
      }
      if (s.signals?.length) {
        lines.push(`**Events:**`);
        s.signals.slice(0, 10).forEach(sig => {
          lines.push(`- [${sig.type}] ${sig.subtype || ''} — "${(sig.text || '').slice(0, 80)}"`);
        });
      }
      lines.push('');
    });
  }

  return lines.join('\n');
}

chrome.storage.local.get(
  { sra_notes: [], sra_text_highlights: {}, sra_sessions: [] },
  ({ sra_notes, sra_text_highlights, sra_sessions }) => {
    const md = buildMarkdown(sra_notes, sra_text_highlights, sra_sessions);
    document.getElementById('preview').textContent = md;

    const noteCount = (sra_notes || []).length;
    const hlCount   = Object.values(sra_text_highlights || {}).reduce((a, b) => a + (b?.length || 0), 0);
    const sesCount  = (sra_sessions || []).length;
    document.getElementById('statLine').textContent =
      `${noteCount} note${noteCount!==1?'s':''} · ${hlCount} highlight${hlCount!==1?'s':''} · ${sesCount} session${sesCount!==1?'s':''}`;

    document.getElementById('downloadBtn').addEventListener('click', () => {
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url;
      a.download = `tldr-annotations-${new Date().toISOString().slice(0,10)}.md`;
      a.click();
      URL.revokeObjectURL(url);
    });

    document.getElementById('copyBtn').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(md);
        const btn = document.getElementById('copyBtn');
        btn.textContent = 'Copied ✓';
        setTimeout(() => { btn.textContent = 'Copy to clipboard'; }, 2000);
      } catch (_) {}
    });
  }
);
