/* reading-bridge.js — wires alcoia's detection pipeline into its own PDF
 * viewer (item 30c).
 *
 * viewer.js renders real pdf.js .textLayer spans for every page (see its own
 * header) — the exact DOM shape pdf-handler.js's groupTextLayerParagraphs()
 * already knows how to group into paragraphs (item 30c added that export
 * specifically so this file and pdf-handler.js's own one-shot manual-lookup
 * path could share one grouping algorithm instead of two). This module feeds
 * that grouping into paragraph-tracker.js's injected block source (item 30b)
 * so the rest of the pipeline — orchestrator.js, host.js, ui-controller.js —
 * runs completely unmodified, exactly as it does on an ordinary DOM page. No
 * PDF-specific code is imported by paragraph-tracker.js or orchestrator.js
 * themselves; the PDF-awareness lives entirely in this file.
 *
 * This is a real ES module (viewer.html loads it via `type="module"`), so it
 * uses static imports for its own direct dependencies, matching quiz.js's
 * and session-report.js's existing extension-page convention rather than
 * content.js's own dynamic loadModule() — that pattern exists there only
 * because a content script cannot use top-level `import` syntax at all. A
 * `loadModule` function is still constructed below and passed into
 * createHost()/createOrchestrator(), because those two modules must remain
 * callable from either context and always resolve their OWN sub-dependencies
 * (state-engine.js, coverage-gate.js, the six signal detectors, ...) through
 * an injected loader rather than a static import list of their own.
 *
 * Each PDF paragraph is represented to the tracker as a real, DETACHED
 * <span> — never inserted into the page — rather than a plain duck-typed
 * object, for two concrete reasons:
 *   - .textContent is set to the paragraph's real text, so
 *     intervention-policy.js's UNCHANGED paragraphKey() dedup
 *     (`el.innerText || el.textContent`) resolves correctly with no special
 *     case: .innerText is empty on a detached node (it depends on layout,
 *     which a detached node never gets), so it falls through to
 *     .textContent exactly as intended. This is the resolution to the
 *     identity-key gap item 30b's own CLAUDE.md section flagged for
 *     whichever item wired a real injector — this is that item.
 *   - It has a real classList, so ui-controller.js's highlightElement()
 *     (called unconditionally by host.js's handleAsk()/onIntervention() on
 *     whatever `target` it is handed) runs without throwing on a plain
 *     object with no classList. It never renders anything visible for a
 *     detached node regardless — see getSettings()'s highlightEnabled below
 *     — so this only matters as a safety property, not a rendering one.
 * .getBoundingClientRect is overridden per element to return a live union
 * of the paragraph's real (attached, currently-rendered) text-layer spans,
 * recomputed fresh on every single call — the same "ask the DOM again,
 * right now" contract a real attached element's own native method has, and
 * exactly what elementAtReadingLine() in paragraph-tracker.js already
 * assumes for every paragraph regardless of source.
 *
 * Per-paragraph <span> identity is CACHED and reused across scans, keyed by
 * pdf-handler.js's own `pdf-p-N` id, rather than rebuilt on every call.
 * paragraph-tracker.js's update() compares el identity (`nextEl ===
 * activeEl`) to decide whether the active paragraph changed — a fresh
 * object every scan would look like a brand new paragraph every ~10s even
 * when the reader hasn't moved, resetting dwell time continuously and
 * breaking the WPM baseline and every dwell-based signal built on top of it.
 */

import { createUIController, esc } from '../content/ui-controller.js';
import { createHost } from '../content/host.js';
import { createOrchestrator } from '../content/orchestrator.js';
import { groupTextLayerParagraphs, unionRect } from '../content/pdf-handler.js';
import { detectLanguage, countWords } from '../content/signals/segmentation.js';
import { createSessionManager } from '../shared/session.js';

export async function attachReadingBridge({ sourceUrl, assignmentId, debug } = {}) {
  const loadModule = (p) => import(chrome.runtime.getURL(p));
  const _log  = (...a) => console.log('[alcoia]', ...a);
  const _warn = (...a) => console.warn('[alcoia]', ...a);

  // ── Settings — the same sra_* storage keys and live-update pattern
  // content.js uses, restricted to what this page's pipeline actually
  // reads. There is no highlight/selection/receipt/SPA-nav surface here —
  // item 30a's own inventory marks all of that content-script-only, tied to
  // an arbitrary web page's own DOM, which a PDF viewer does not have. ──
  let assistantEnabled = true;
  let backendUrl = self.ALCOIA_CONFIG.SUMMARIZE_URL;
  let comprehensionCheckEnabled = true;
  let debugEnabled = !!debug;
  let pinDefault = false;
  let autohideEnabled = false;
  let autohideTimeoutSec = 12;

  // hostApi is constructed just below and needed by ui's own fetchSummary
  // callback, which is only ever invoked later from a click handler, never
  // at construction time — the same deferred-reference pattern content.js
  // already uses for this exact circularity (ui-controller.js "owns
  // openPopups and nothing else may mutate it", so there is only ever one
  // instance, built once, here).
  let hostApi = null;
  const ui = createUIController({
    // The viewer has no DOM paragraph to add a CSS class to — every tracked
    // "paragraph" here is a detached <span> (see header), so a highlight
    // would never be visible regardless. Hardcoded off rather than read
    // from sra_highlight_para, which is the DOM "outline the paragraph"
    // feature and has no meaning on this page.
    getSettings: () => ({ highlightEnabled: false, pinDefault, autohideEnabled, autohideTimeoutSec }),
    fetchSummary: (...a) => hostApi.fetchSummary(...a),
  });

  // Item S6/E4 follow-up: only ever constructed when this document was
  // opened FROM the Assignments entry point (assignments.js's own
  // `?assignmentId=` param, read by viewer.js) — a local file:// or
  // ordinary web PDF passes none, so host.js's outcome-reporting stays
  // entirely inert for those, unchanged from before this item. A real ES
  // module context (viewer.html loads this file via `type="module"`), so
  // this can construct session.js directly the same way join-class.js/
  // upgrade.js already do, rather than going through loadModule().
  const session = assignmentId ? createSessionManager() : null;

  hostApi = await createHost({
    loadModule,
    ui,
    esc,
    log: _log,
    warn: _warn,
    settings: () => ({ assistantEnabled, backendUrl }),
    assignmentId,
    getSession: session ? session.getSession : null,
  });

  // ── The PDF paragraph model, fed to paragraph-tracker.js as an injected
  // block source (item 30b) ───────────────────────────────────────────────
  const elCache = new Map(); // pdf-handler.js paragraph id -> detached <span>
  function pdfBlockSource() {
    const groups = groupTextLayerParagraphs(document);
    const lang = detectLanguage(document);
    const seen = new Set();
    const blocks = groups.map((g) => {
      seen.add(g.id);
      let el = elCache.get(g.id);
      if (!el || el.textContent !== g.text) {
        el = document.createElement('span');
        el.textContent = g.text;
        elCache.set(g.id, el);
      }
      // Reassigned every call so it always closes over THIS call's live
      // span references — cheap, and keeps the rect live even though the
      // element itself is reused across scans for identity stability.
      el.getBoundingClientRect = () => unionRect(g.spans);
      return { el, words: countWords(g.text, lang), media: false };
    });
    // Paragraphs that no longer exist (a genuine document swap — see
    // handleRebuild() below) should not keep stale cached elements alive
    // forever; every other case only ever grows the id list.
    for (const id of [...elCache.keys()]) { if (!seen.has(id)) elCache.delete(id); }
    return blocks;
  }

  const orchestrator = await createOrchestrator({
    loadModule,
    comprehensionMonitor: hostApi.comprehensionMonitor,
    settings: () => ({
      assistantEnabled, comprehensionCheckEnabled,
      focusRulerEnabled: false, // no DOM reading-line surface on a canvas+text-layer page; not attempted here
      debugEnabled,
    }),
    host: hostApi.host,
    paragraphTrackerOpts: { blockSource: pdfBlockSource },
    // This page's own window.location is alcoia's viewer URL — identical
    // for every distinct PDF ever opened here. Key on the real underlying
    // document's source URL instead, or every PDF would share one
    // coverage/quiz-eligibility record. See orchestrator.js's own item-30c
    // comment on the `documentKey` option this relies on.
    documentKey: () => (sourceUrl ? `pdf:${sourceUrl}` : null),
  });
  // host.js's questionCard/runQuiz callbacks reference orchestrator, which
  // did not exist yet when they were built — see host.js's own header for
  // why this is safe.
  hostApi.setOrchestrator(orchestrator);

  // ── Settings load + live updates ────────────────────────────────────────
  function applySettings(res) {
    assistantEnabled = res.sra_enabled !== false;
    backendUrl = res.sra_backend_url || self.ALCOIA_CONFIG.SUMMARIZE_URL;
    comprehensionCheckEnabled = res.sra_comprehension !== false;
    debugEnabled = !!res.sra_debug;
    pinDefault = !!res.sra_pin_default;
    autohideEnabled = !!res.sra_autohide;
    autohideTimeoutSec = res.sra_autohide_timeout || 12;
  }

  const SETTINGS_DEFAULTS = {
    sra_enabled: true, sra_backend_url: self.ALCOIA_CONFIG.SUMMARIZE_URL,
    sra_comprehension: true, sra_debug: false,
    sra_pin_default: false, sra_autohide: false, sra_autohide_timeout: 12,
  };

  await new Promise((resolve) => {
    chrome.storage.local.get(SETTINGS_DEFAULTS, (res) => { applySettings(res); resolve(); });
  });

  /* The popup only messages the active tab — and per item 30a's own finding,
   * Chrome never injects a content script into a chrome-extension:// page at
   * all, so this page could never receive that message even if it tried.
   * Storage is the one channel this page can hear regardless. */
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (!Object.keys(SETTINGS_DEFAULTS).some((k) => k in changes)) return;
      chrome.storage.local.get(SETTINGS_DEFAULTS, applySettings);
    });
  } catch (e) { /* no storage in this context */ }

  orchestrator.installListeners();

  return {
    orchestrator,
    // Called once the first page(s) have rendered — populates the tracker
    // immediately rather than waiting on its own ~10s lazy rescan.
    primeParagraph() { try { orchestrator.primeParagraph(); } catch (e) {} },
    // Called after rebuildAllPages() (zoom in/out): every existing
    // .textLayer span is gone, replaced by new ones at a new scale — the
    // same shape of problem item 27 solved for a genuine SPA route change
    // (in-flight state pointing at DOM that no longer exists), so this
    // reuses that exact reset path rather than inventing a new one.
    handleRebuild() { try { orchestrator.handleRouteChange(); } catch (e) {} },
    // Item DC-1a — viewer.js's own beforeunload handler calls this; a no-op
    // unless this bridge was attached with a real assignmentId (see
    // host.js's own gate, unchanged here).
    submitKinematics: hostApi.submitKinematics,
  };
}
