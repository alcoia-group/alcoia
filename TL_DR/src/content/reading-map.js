/* reading-map.js
   A collapsible right-side sidebar showing:
   - Article progress bar
   - Heading minimap (clickable)
   - Paragraph event markers (green = summarized, orange = confused, red = overloaded)
*/

const MAP_ID    = 'sra-reading-map';
const TAB_ID    = 'sra-reading-map-tab';
const WIDTH_PX  = 190;

const EVENT_COLOR = {
  summarized: '#1A7E5D',
  confused:   '#a06000',
  overloaded: '#8b2000',
  zoning_out: '#5a3e8a',
  skimming:   '#2563a8',
};

export function createReadingMap() {
  let visible  = false;
  let headings = [];
  let events   = [];   // { pct, type, label }
  let rafId    = null;

  // ── DOM construction ────────────────────────────────────────────────────
  function ensureDOM() {
    if (document.getElementById(MAP_ID)) return;

    const style = document.createElement('style');
    style.textContent = `
      #${MAP_ID} {
        position: fixed; top: 0; right: 0; bottom: 0;
        width: ${WIDTH_PX}px; transform: translateX(100%);
        transition: transform 0.22s cubic-bezier(.4,0,.2,1);
        background: rgba(250,250,247,0.96);
        border-left: 1px solid rgba(26,126,93,0.14);
        box-shadow: -4px 0 20px rgba(0,0,0,0.08);
        z-index: 2147483635;
        display: flex; flex-direction: column;
        font-family: 'Fraunces', Georgia, serif;
        backdrop-filter: blur(6px);
        overflow: hidden;
      }
      #${MAP_ID}.open { transform: translateX(0); }

      #${TAB_ID} {
        position: fixed; top: 50%; right: 0;
        transform: translateY(-50%) translateX(0);
        transition: transform 0.22s cubic-bezier(.4,0,.2,1);
        background: rgba(26,126,93,0.88);
        color: white; border: none; cursor: pointer;
        border-radius: 8px 0 0 8px;
        padding: 10px 5px; writing-mode: vertical-rl;
        font-family: 'Fraunces', Georgia, serif; font-size: 10px; letter-spacing: 0.8px;
        z-index: 2147483636; box-shadow: -2px 0 8px rgba(0,0,0,0.12);
      }
      #${TAB_ID}.open { transform: translateY(-50%) translateX(-${WIDTH_PX}px); }

      .sra-map-progress-bar {
        height: 3px; background: rgba(26,126,93,0.15); flex-shrink: 0;
      }
      .sra-map-progress-fill {
        height: 100%; background: #1A7E5D;
        width: 0%; transition: width 0.3s ease;
      }
      .sra-map-header {
        padding: 10px 12px 6px;
        font-size: 10px; font-weight: 700; letter-spacing: 1px;
        text-transform: uppercase; color: #7a7a72;
        border-bottom: 1px solid rgba(26,126,93,0.1);
        flex-shrink: 0;
        display: flex; align-items: center; justify-content: space-between;
      }
      .sra-map-pct { color: #1A7E5D; font-size: 11px; font-weight: 700; font-style: italic; }
      .sra-map-body { flex: 1; overflow-y: auto; padding: 8px 0; }
      .sra-map-heading {
        display: block; padding: 4px 12px;
        font-size: 11px; line-height: 1.35; color: #2c2c2a;
        cursor: pointer; text-decoration: none;
        transition: background 0.1s; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis;
        border-left: 2px solid transparent;
      }
      .sra-map-heading:hover { background: rgba(26,126,93,0.06); }
      .sra-map-heading.current { border-left-color: #1A7E5D; color: #1A7E5D; font-weight: 700; }
      .sra-map-heading[data-level="1"] { font-weight: 700; }
      .sra-map-heading[data-level="2"] { padding-left: 18px; color: #444; }
      .sra-map-heading[data-level="3"] { padding-left: 26px; color: #666; font-size: 10.5px; }
      .sra-map-heading[data-level="4"] { padding-left: 32px; color: #888; font-size: 10px; }

      .sra-map-divider { height: 1px; background: rgba(26,126,93,0.1); margin: 6px 12px; }

      .sra-map-events { padding: 0 12px 8px; }
      .sra-map-events-label {
        font-size: 9px; font-weight: 700; letter-spacing: 1px;
        text-transform: uppercase; color: #bbb; margin-bottom: 5px;
      }
      .sra-map-event {
        display: flex; align-items: baseline; gap: 6px;
        font-size: 10px; color: #555; margin-bottom: 3px;
        font-style: italic; line-height: 1.3;
      }
      .sra-map-event-dot {
        width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
        position: relative; top: 1px;
      }
      .sra-map-event-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    `;
    document.head.appendChild(style);

    // Tab toggle button
    const tab = document.createElement('button');
    tab.id = TAB_ID;
    tab.textContent = 'MAP';
    tab.title = 'Toggle reading map (Alt+M)';
    tab.addEventListener('click', () => toggle());
    document.body.appendChild(tab);

    // Sidebar
    const sidebar = document.createElement('div');
    sidebar.id = MAP_ID;

    sidebar.innerHTML = `
      <div class="sra-map-progress-bar"><div class="sra-map-progress-fill" id="sra-map-fill"></div></div>
      <div class="sra-map-header">
        <span>Reading map</span>
        <span class="sra-map-pct" id="sra-map-pct">0%</span>
      </div>
      <div class="sra-map-body" id="sra-map-body"></div>`;

    document.body.appendChild(sidebar);

    // Scroll → update progress + current heading
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  function onScroll() {
    const scrollTop = window.scrollY;
    const scrollH   = document.documentElement.scrollHeight - window.innerHeight;
    const pct       = scrollH > 0 ? Math.round(scrollTop / scrollH * 100) : 0;

    const fill = document.getElementById('sra-map-fill');
    const pctEl = document.getElementById('sra-map-pct');
    if (fill)  fill.style.width = pct + '%';
    if (pctEl) pctEl.textContent = pct + '%';

    // Highlight current heading
    let current = null;
    for (const h of headings) {
      if (h.el.getBoundingClientRect().top <= 80) current = h;
    }
    document.querySelectorAll('.sra-map-heading').forEach(el => {
      el.classList.toggle('current', el.dataset.headingId === (current?.id || ''));
    });
  }

  function buildHeadings() {
    headings = [];
    const els = document.querySelectorAll('h1,h2,h3,h4');
    els.forEach((el, i) => {
      if (!el.id) el.id = `sra-h-${i}`;
      headings.push({ el, id: el.id, level: +el.tagName[1], text: el.textContent.trim().slice(0, 60) });
    });
  }

  function renderBody() {
    const body = document.getElementById('sra-map-body');
    if (!body) return;
    body.innerHTML = '';

    if (!headings.length) {
      const msg = document.createElement('div');
      msg.style.cssText = 'padding:12px;font-size:11px;color:#aaa;font-style:italic;';
      msg.textContent = 'No headings found on this page.';
      body.appendChild(msg);
    } else {
      headings.forEach(h => {
        const a = document.createElement('a');
        a.className = 'sra-map-heading';
        a.dataset.level = h.level;
        a.dataset.headingId = h.id;
        a.textContent = h.text;
        a.href = '#' + h.id;
        a.addEventListener('click', e => {
          e.preventDefault();
          document.getElementById(h.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        body.appendChild(a);
      });
    }

    // Event log
    if (events.length) {
      const div = document.createElement('div');
      div.className = 'sra-map-divider';
      body.appendChild(div);

      const evSection = document.createElement('div');
      evSection.className = 'sra-map-events';
      const lbl = document.createElement('div');
      lbl.className = 'sra-map-events-label';
      lbl.textContent = 'Events';
      evSection.appendChild(lbl);

      events.slice(-20).reverse().forEach(ev => {
        const row = document.createElement('div');
        row.className = 'sra-map-event';
        const dot = document.createElement('span');
        dot.className = 'sra-map-event-dot';
        dot.style.background = EVENT_COLOR[ev.type] || '#aaa';
        const txt = document.createElement('span');
        txt.className = 'sra-map-event-text';
        txt.title = ev.label;
        txt.textContent = `${ev.pct}% · ${ev.label}`;
        row.appendChild(dot);
        row.appendChild(txt);
        evSection.appendChild(row);
      });
      body.appendChild(evSection);
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────
  function toggle() {
    visible = !visible;
    ensureDOM();
    document.getElementById(MAP_ID)?.classList.toggle('open', visible);
    document.getElementById(TAB_ID)?.classList.toggle('open', visible);
    if (visible) {
      buildHeadings();
      renderBody();
      onScroll();
    }
  }

  function recordEvent(type, text) {
    ensureDOM();
    const scrollH = document.documentElement.scrollHeight - window.innerHeight;
    const pct     = scrollH > 0 ? Math.round(window.scrollY / scrollH * 100) : 0;
    events.push({ type, pct, label: (text || type).slice(0, 40) });
    if (events.length > 100) events.shift();
    if (visible) renderBody();
  }

  return { toggle, recordEvent };
}
