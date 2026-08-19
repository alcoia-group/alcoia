import { mountHighlights } from '../shared/highlights-render.js';

// Follows the same dark-mode setting every other extension page reads, and
// stays in sync if it changes while this page is open (e.g. toggled in the
// popup in another window).
chrome.storage.local.get({ sra_dark_mode: false }, ({ sra_dark_mode }) => {
  document.body.classList.toggle('dark-mode', !!sra_dark_mode);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.sra_dark_mode) {
    document.body.classList.toggle('dark-mode', !!changes.sra_dark_mode.newValue);
  }
});

mountHighlights(document.body, {
  openUrl: (url) => chrome.tabs.create({ url }),
});
