/* highlights-sidebar.js
 *
 * The reader's saved highlights, in a panel that slides in over whatever
 * page they are already reading, so seeing them again does not mean leaving
 * the article for a separate extension tab. Same storage, same filtering,
 * same delete paths as the standalone Highlights page
 * (src/popup/highlights.js) via the one shared module both import, so the
 * two surfaces cannot silently drift into two different feature sets. The
 * standalone page is still reachable through the Expand button here.
 *
 * Colours come from the --alc-* tokens overlay.css declares on the host
 * page's :root, the same ones ui-controller.js's applyDarkMode() swaps —
 * dark mode here is a side effect of that, not separate logic.
 */
import { mountHighlights } from '../shared/highlights-render.js';

const PANEL_ID = 'sra-hl-sidebar';
const STYLE_ID = PANEL_ID + '-styles';
const WIDTH_PX = 340;

export function createHighlightsSidebar() {
  let mounted = null;

  function ensureDOM() {
    if (document.getElementById(PANEL_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        position: fixed; top: 0; right: 0; bottom: 0;
        width: min(${WIDTH_PX}px, 92vw);
        transform: translateX(100%);
        transition: transform 0.22s cubic-bezier(.4,0,.2,1);
        background: var(--alc-paper, #F9F7F2);
        color: var(--alc-text, #333333);
        border-left: 1px solid var(--alc-border, rgba(51,51,51,0.12));
        box-shadow: -8px 0 28px rgba(0,0,0,0.14);
        z-index: 2147483637;
        display: flex; flex-direction: column;
        font-family: var(--alc-ui, system-ui, sans-serif);
        font-size: 12.5px;
      }
      #${PANEL_ID}.open { transform: translateX(0); }
      #${PANEL_ID} *, #${PANEL_ID} *::before, #${PANEL_ID} *::after { box-sizing: border-box; }

      .sra-hls-header {
        display: flex; align-items: flex-start; justify-content: space-between;
        gap: 8px; padding: 12px 14px 10px;
        border-bottom: 1px solid var(--alc-border, rgba(51,51,51,0.12));
        flex-shrink: 0;
      }
      .sra-hls-title { font-size: 13px; font-weight: 700; }
      .sra-hls-count { font-size: 10.5px; color: var(--alc-muted, #6B6862); margin-top: 2px; }
      .sra-hls-actions { display: flex; gap: 2px; align-items: center; flex-shrink: 0; }
      .sra-hls-icon-btn {
        background: none; border: none; cursor: pointer; padding: 4px 8px;
        border-radius: 6px; font-size: 11px; color: var(--alc-muted, #6B6862);
        font-family: var(--alc-ui, system-ui, sans-serif);
      }
      .sra-hls-icon-btn:hover { background: var(--alc-accent-sf, rgba(126,96,174,0.08)); color: var(--alc-accent, #7E60AE); }

      .sra-hls-controls {
        display: flex; gap: 6px; flex-wrap: wrap; align-items: center;
        padding: 10px 14px; border-bottom: 1px solid var(--alc-border, rgba(51,51,51,0.12));
        flex-shrink: 0;
      }
      .sra-hls-body { flex: 1; overflow-y: auto; padding: 12px 14px 30px; }

      #${PANEL_ID} .filter-btn {
        padding: 3px 10px; border-radius: 20px; border: 1px solid var(--alc-border, rgba(51,51,51,0.12));
        background: none; cursor: pointer; font-family: var(--alc-ui, system-ui, sans-serif);
        font-size: 10.5px; color: var(--alc-muted, #6B6862);
      }
      #${PANEL_ID} .filter-btn.active {
        background: var(--alc-accent, #7E60AE); color: white; border-color: var(--alc-accent, #7E60AE);
      }
      #${PANEL_ID} .filter-swatch {
        width: 12px; height: 12px; border-radius: 50%; display: inline-block;
        vertical-align: middle; margin-right: 4px; border: 1px solid rgba(0,0,0,0.1);
      }
      #${PANEL_ID} .clear-all {
        margin-left: auto; background: none; border: none; font-family: var(--alc-ui, system-ui, sans-serif);
        font-size: 10.5px; color: var(--alc-wrong, #B4795F); cursor: pointer; padding: 3px 6px; border-radius: 6px;
      }
      #${PANEL_ID} .clear-all:hover { background: rgba(180,121,95,0.12); }

      #${PANEL_ID} .hl-card {
        background: var(--alc-surface, #FFFFFF); border: 1px solid var(--alc-border, rgba(51,51,51,0.12));
        border-radius: 10px; padding: 11px 13px; position: relative; border-left: 3px solid #ccc;
        margin-bottom: 9px; cursor: pointer;
      }
      #${PANEL_ID} .hl-card:hover { box-shadow: 0 3px 12px rgba(0,0,0,0.10); }
      #${PANEL_ID} .hl-card:focus-visible { outline: 2px solid var(--alc-accent, #7E60AE); outline-offset: 2px; }
      #${PANEL_ID} .hl-text { font-size: 12px; line-height: 1.55; margin-bottom: 7px; color: var(--alc-text, #333333); }
      #${PANEL_ID} .hl-explanation { margin: 0 0 7px; }
      #${PANEL_ID} .hl-explanation summary {
        cursor: pointer; font-size: 10px; color: var(--alc-accent, #7E60AE); list-style: none;
        display: inline-flex; align-items: center; gap: 4px;
      }
      #${PANEL_ID} .hl-explanation summary::-webkit-details-marker { display: none; }
      #${PANEL_ID} .hl-explanation-text {
        font-size: 11px; line-height: 1.55; color: var(--alc-text, #333333); margin-top: 5px;
        padding: 7px 9px; background: var(--alc-accent-sf, rgba(126,96,174,0.06)); border-radius: 7px;
      }
      #${PANEL_ID} .hl-meta {
        font-size: 9.5px; color: var(--alc-muted, #6B6862); display: flex; gap: 8px;
        align-items: center; flex-wrap: wrap;
      }
      #${PANEL_ID} .hl-site { max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${PANEL_ID} .hl-doc-delete { flex-shrink: 0; color: var(--alc-muted, #6B6862); cursor: pointer; text-decoration: underline; }
      #${PANEL_ID} .hl-doc-delete:hover { color: var(--alc-wrong, #B4795F); }
      #${PANEL_ID} .hl-delete {
        position: absolute; top: 8px; right: 10px; background: none; border: none; cursor: pointer;
        font-size: 15px; color: var(--alc-faint, #9A968E); line-height: 1; padding: 2px;
      }
      #${PANEL_ID} .hl-delete:hover { color: var(--alc-wrong, #B4795F); }

      #${PANEL_ID} .hl-empty { text-align: center; padding: 50px 16px; color: var(--alc-muted, #6B6862); }
      #${PANEL_ID} .hl-empty-icon { font-size: 30px; margin-bottom: 10px; opacity: 0.4; }
      #${PANEL_ID} .hl-empty p { font-size: 12px; line-height: 1.6; }
      #${PANEL_ID} .hl-empty code {
        background: var(--alc-accent-sf, rgba(126,96,174,0.08)); border-radius: 4px; padding: 1px 6px;
        font-size: 10.5px; color: var(--alc-accent, #7E60AE);
      }
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="sra-hls-header">
        <div>
          <div class="sra-hls-title">My highlights</div>
          <div class="sra-hls-count" data-hl-count></div>
        </div>
        <div class="sra-hls-actions">
          <button type="button" class="sra-hls-icon-btn" data-hl-expand title="Open the full Highlights page in a new tab">Expand</button>
          <button type="button" class="sra-hls-icon-btn" data-hl-close title="Close">Close</button>
        </div>
      </div>
      <div class="sra-hls-controls" data-hl-controls>
        <button class="filter-btn active" data-color="all">All</button>
        <button class="filter-btn" data-color="yellow"><span class="filter-swatch" style="background:#FFF59D"></span>Yellow</button>
        <button class="filter-btn" data-color="green"><span class="filter-swatch" style="background:#A5D6A7"></span>Green</button>
        <button class="filter-btn" data-color="blue"><span class="filter-swatch" style="background:#90CAF9"></span>Blue</button>
        <button class="filter-btn" data-color="pink"><span class="filter-swatch" style="background:#F48FB1"></span>Pink</button>
        <button class="filter-btn" data-color="orange"><span class="filter-swatch" style="background:#FFCC80"></span>Orange</button>
        <button class="clear-all" data-hl-clear-all>Clear all</button>
      </div>
      <div class="sra-hls-body" data-hl-list></div>
    `;
    document.body.appendChild(panel);

    panel.querySelector('[data-hl-close]').addEventListener('click', close);
    panel.querySelector('[data-hl-expand]').addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'openTab', url: chrome.runtime.getURL('src/popup/highlights.html') });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.getElementById(PANEL_ID)?.classList.contains('open')) close();
    });

    mounted = mountHighlights(panel, {
      // Content scripts cannot call chrome.tabs.create directly; background.js's
      // existing 'openTab' relay (already used elsewhere in this file) is the
      // one path a content script has to opening a new tab.
      openUrl: (url) => chrome.runtime.sendMessage({ action: 'openTab', url }),
    });
  }

  function open() {
    ensureDOM();
    mounted?.refresh();
    document.getElementById(PANEL_ID)?.classList.add('open');
  }
  function close() {
    document.getElementById(PANEL_ID)?.classList.remove('open');
  }
  function toggle() {
    const panel = document.getElementById(PANEL_ID);
    if (panel?.classList.contains('open')) close(); else open();
  }

  return { open, close, toggle };
}
