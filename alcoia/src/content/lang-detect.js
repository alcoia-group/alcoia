// lang-detect.js — Script detection and gaze feature patching for multilingual support
//
// Three adaptations:
//  RTL (Arabic, Hebrew, Persian, …): the classifier was trained on LTR gaze data where
//    leftward saccades (dx < -20) count as regressions. For RTL readers those same
//    leftward saccades are FORWARD reading, so regression_rate is inverted before
//    classification.
//  CJK (Chinese, Japanese, Korean): character-based scripts have naturally longer
//    fixation durations (~30-40% above alphabetic baselines). avg_fixation_ms and
//    fixation_std are scaled down so the trained thresholds stay meaningful.
//  AI output language: already handled by the server-side prompt suffix
//    "Respond in the same language as the passage."

const RTL_LANGS = /^(ar|he|fa|ur|ps|yi|ug|sd|dv)/i;
const CJK_LANGS = /^(zh|ja|ko)/i;

// Unicode ranges for RTL characters (Arabic, Hebrew, Syriac, Thaana, …)
const RTL_CHAR_RE = /[֐-׿؀-ۿݐ-ݿࢠ-ࣿיִ-﷿ﹰ-﻿]/g;
// Unicode ranges for CJK characters (Hiragana, Katakana, CJK unified, Hangul)
const CJK_CHAR_RE = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/g;

// CJK fixation durations average ~30-40% higher than English due to denser characters.
// Scale features down so the trained thresholds (e.g. 450 ms for confused) stay valid.
const CJK_FIXATION_SCALE = 0.78;

export function detectScript() {
  const lang = (
    document.documentElement.lang ||
    document.querySelector('meta[http-equiv="content-language"]')?.content ||
    ''
  ).toLowerCase();

  const dirAttr =
    document.documentElement.getAttribute('dir') ||
    document.body?.getAttribute('dir') || '';
  const computedDir = getComputedStyle(document.documentElement).direction || 'ltr';

  let isRTL = dirAttr === 'rtl' || computedDir === 'rtl' || RTL_LANGS.test(lang);
  let isCJK = CJK_LANGS.test(lang);

  // Fallback: sample visible text to detect script when lang attribute is absent
  if (!isRTL || !isCJK) {
    const sample = (document.body?.innerText || '').replace(/\s+/g, '').slice(0, 1000);
    if (sample.length >= 40) {
      const rtlCount = (sample.match(RTL_CHAR_RE) || []).length;
      const cjkCount = (sample.match(CJK_CHAR_RE) || []).length;
      if (!isRTL && rtlCount / sample.length > 0.15) isRTL = true;
      if (!isCJK && cjkCount / sample.length > 0.15) isCJK = true;
    }
  }

  // Mixed RTL+CJK is extremely rare; if both fire, RTL flip is more critical
  return { isRTL, isCJK: isCJK && !isRTL, lang };
}

// Watch for SPA navigation that changes the page language without a full reload.
// Covers three signals:
//   1. <html lang> or <html dir> attribute mutation (most SPAs update this)
//   2. popstate / hashchange (history-based navigation)
//   3. direct childList changes on <body> (major DOM rebuild = new page content)
// Returns a cleanup function that disconnects all observers and listeners.
export function watchScriptChanges(onChange) {
  let current = detectScript();

  let debounceTimer = null;
  function schedule() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const next = detectScript();
      if (next.isRTL !== current.isRTL || next.isCJK !== current.isCJK || next.lang !== current.lang) {
        current = next;
        onChange(next);
      }
    }, 200);
  }

  // Signal 1 — <html> lang / dir attribute change
  const attrObserver = new MutationObserver(schedule);
  attrObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['lang', 'dir'],
  });

  // Signal 2 — direct children of <body> replaced (SPA page swap)
  const bodyObserver = new MutationObserver(schedule);
  const observeBody = () => {
    if (document.body) bodyObserver.observe(document.body, { childList: true });
  };
  observeBody();
  if (!document.body) document.addEventListener('DOMContentLoaded', observeBody, { once: true });

  // Signal 3 — URL changes (back/forward, hash navigation)
  window.addEventListener('popstate',   schedule);
  window.addEventListener('hashchange', schedule);

  return function cleanup() {
    clearTimeout(debounceTimer);
    attrObserver.disconnect();
    bodyObserver.disconnect();
    window.removeEventListener('popstate',   schedule);
    window.removeEventListener('hashchange', schedule);
  };
}

export function patchFeaturesForScript(features, scriptInfo) {
  if (!scriptInfo || (!scriptInfo.isRTL && !scriptInfo.isCJK)) return features;

  const patched = { ...features };

  if (scriptInfo.isRTL) {
    // Forward reading saccades in RTL go right→left (dx < −20), which the extractor
    // counts as regressions. Flip regression_rate so a focused RTL reader maps to
    // the same low-regression_rate bucket the classifier expects for focused reading.
    patched.regression_rate = 1 - (patched.regression_rate ?? 0.1);
  }

  if (scriptInfo.isCJK) {
    if (patched.avg_fixation_ms !== undefined)
      patched.avg_fixation_ms = patched.avg_fixation_ms * CJK_FIXATION_SCALE;
    if (patched.fixation_std !== undefined)
      patched.fixation_std = patched.fixation_std * CJK_FIXATION_SCALE;
  }

  return patched;
}
