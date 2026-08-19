/* icons.js — the toolbar/sidebar glyph set.
 *
 * Chrome's own PDF viewer icons are Google's Material Symbols, which are not
 * bundled with this extension and cannot be fetched at build or runtime (no
 * new dependency, no network fetch from a content-adjacent page — see
 * the project notes' "no dependency without asking"). These are hand-drawn
 * equivalents at the same visual weight (20px, 1.6px stroke, currentColor)
 * matching each native icon's silhouette, built from a real screenshot of
 * Chromium's native PDF viewer taken while building item 39, not from
 * memory. They are not byte-identical to Google's assets — see the PR notes
 * on "one thing that cannot match."
 */

const svg = (inner, viewBox = '0 0 20 20') =>
  `<svg viewBox="${viewBox}" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

export const ICONS = {
  sidebar: svg('<line x1="3" y1="5" x2="17" y2="5"/><line x1="3" y1="10" x2="17" y2="10"/><line x1="3" y1="15" x2="17" y2="15"/>'),

  zoomOut: svg('<line x1="4" y1="10" x2="16" y2="10"/>'),
  zoomIn:  svg('<line x1="4" y1="10" x2="16" y2="10"/><line x1="10" y1="4" x2="10" y2="16"/>'),

  // A page silhouette with a small marker near the top — stands in for the
  // fit-mode toggle (cycles fit-width / fit-page / actual-size).
  fit: svg('<rect x="5" y="3" width="10" height="14" rx="1.5"/><rect x="9" y="6" width="2" height="2" rx="0.4" fill="currentColor" stroke="none"/>'),

  rotate: svg('<path d="M15.5 8A5.5 5.5 0 1 0 16 11"/><path d="M15.5 4v4.4h-4.4"/>'),

  download: svg('<path d="M10 3v10"/><path d="M5.5 9 10 13.5 14.5 9"/><path d="M4 16.5h12"/>'),
  print:    svg('<path d="M6 8V3.5h8V8"/><rect x="3.5" y="8" width="13" height="6.5" rx="1"/><path d="M6 13v3.5h8V13"/>'),
  kebab:    svg('<circle cx="10" cy="4.2" r="1.3" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.3" fill="currentColor" stroke="none"/><circle cx="10" cy="15.8" r="1.3" fill="currentColor" stroke="none"/>'),

  close: svg('<line x1="5" y1="5" x2="15" y2="15"/><line x1="15" y1="5" x2="5" y2="15"/>'),

  // Sidebar tab icons — only shown when the document actually has both a
  // thumbnail strip and a real outline to switch between.
  thumbnails: svg('<rect x="3" y="3" width="6" height="7.5" rx="1"/><rect x="11" y="3" width="6" height="7.5" rx="1"/><rect x="3" y="12.5" width="6" height="4.5" rx="1"/><rect x="11" y="12.5" width="6" height="4.5" rx="1"/>'),
  outlineTab: svg('<line x1="4" y1="5" x2="16" y2="5"/><line x1="6" y1="10" x2="16" y2="10"/><line x1="8" y1="15" x2="16" y2="15"/>'),

  chevronRight: svg('<path d="M7.5 4.5 13 10l-5.5 5.5"/>'),

  // Kebab-menu entries.
  twoPage:   svg('<rect x="2.5" y="3" width="6.5" height="14" rx="1"/><rect x="11" y="3" width="6.5" height="14" rx="1"/>'),
  present:   svg('<rect x="2.5" y="4" width="15" height="10" rx="1"/><path d="M7 17h6"/><path d="M10 14v3"/>'),
  outline:   svg('<line x1="4" y1="5" x2="16" y2="5"/><line x1="4" y1="10" x2="16" y2="10"/><line x1="4" y1="15" x2="16" y2="15"/>'),
  properties: svg('<circle cx="10" cy="10" r="7"/><line x1="10" y1="9" x2="10" y2="14"/><circle cx="10" cy="6.3" r="0.9" fill="currentColor" stroke="none"/>'),
  openNative: svg('<path d="M8 4H4v12h12v-4"/><path d="M11 3h6v6"/><path d="M9 11 17 3"/>'),
  check:      svg('<path d="M4 10.5 8 14.5 16 5.5"/>'),

  lock: svg('<rect x="4.5" y="9" width="11" height="8" rx="1.5"/><path d="M6.5 9V6.5a3.5 3.5 0 0 1 7 0V9"/>'),
};
