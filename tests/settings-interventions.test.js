/* "Show intervention popups" and "Show the self-report button" — two new,
 * independent, view-only switches on the settings page's existing
 * Interventions card, both on by default.
 *
 *   - "Show intervention popups" (sra_show_interventions): host.js's own
 *     automatic-render gate, already covered behaviourally in
 *     tests/host.test.js (onIntervention/checkRetentionCandidate/checkProbe
 *     each have a dedicated "respects showInterventions: false" test).
 *   - "Show the self-report button" (sra_show_self_report): controls only
 *     the persistent "?" trigger's own visibility, via host.js's
 *     setShowSelfReportButton — also covered behaviourally in
 *     tests/host.test.js's "self-report (item 13a)" block.
 *
 * This file covers the one layer those tests don't reach: content.js and
 * reading-bridge.js are the two places that actually read the new storage
 * keys and thread them into host.js's settings()/setShowSelfReportButton —
 * neither is a real ES module host.test.js can import and drive directly
 * (content.js is a non-modular IIFE; reading-bridge.js has no injectable
 * chrome/storage seam of its own). Static source checks, same convention
 * tests/settings-backend-url.test.js and tests/dev-controls.test.js already
 * use for this exact reason. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const settingsHtml   = read('alcoia/src/popup/settings.html');
const settingsJs     = read('alcoia/src/popup/settings.js');
const contentJs      = read('alcoia/src/content/content.js');
const hostJs         = read('alcoia/src/content/host.js');
const readingBridgeJs = read('alcoia/src/pdf-viewer/reading-bridge.js');

describe('settings.html — two new toggles, both default on', () => {
  it('has "Show intervention popups", checked by default, on the Interventions card', () => {
    const cardStart = settingsHtml.indexOf('Interventions</div>');
    const cardBlock = settingsHtml.slice(cardStart, cardStart + 2000);
    expect(cardBlock).toMatch(/id="showInterventionsToggle"[^>]*checked/);
  });

  it('has "Show the self-report button", checked by default, on the same card', () => {
    const cardStart = settingsHtml.indexOf('Interventions</div>');
    const cardBlock = settingsHtml.slice(cardStart, cardStart + 2000);
    expect(cardBlock).toMatch(/id="showSelfReportToggle"[^>]*checked/);
  });

  it('no longer claims there is nothing to toggle for the self-report button', () => {
    // The stale comment this item replaces said exactly this; confirms the
    // old claim was removed, not merely shadowed by new markup elsewhere.
    expect(settingsHtml).not.toMatch(/there is nothing to toggle/);
    expect(settingsHtml).not.toMatch(/there is no separate visibility\s*\n?\s*switch for either/);
  });
});

describe('settings.js — storage keys, defaults, and the broadcast', () => {
  it('DEFAULTS includes both keys, both true', () => {
    const block = settingsJs.slice(
      settingsJs.indexOf('const DEFAULTS'),
      settingsJs.indexOf('};', settingsJs.indexOf('const DEFAULTS')),
    );
    expect(block).toMatch(/sra_show_interventions:\s*true/);
    expect(block).toMatch(/sra_show_self_report:\s*true/);
  });

  it('paint() sets both toggles from storage, defaulting to checked', () => {
    const fnBody = settingsJs.slice(
      settingsJs.indexOf('function paint'),
      settingsJs.indexOf('\n}', settingsJs.indexOf('function paint')),
    );
    expect(fnBody).toMatch(/showInterventionsToggle\.checked\s*=\s*res\.sra_show_interventions\s*!==\s*false/);
    expect(fnBody).toMatch(/showSelfReportToggle\.checked\s*=\s*res\.sra_show_self_report\s*!==\s*false/);
  });

  it('saveAndBroadcast() both saves and broadcasts both keys', () => {
    const fnBody = settingsJs.slice(
      settingsJs.indexOf('function saveAndBroadcast'),
      settingsJs.indexOf('\n}', settingsJs.indexOf('function saveAndBroadcast')),
    );
    expect(fnBody).toMatch(/sra_show_interventions:\s*showInterventionsToggle\.checked/);
    expect(fnBody).toMatch(/sra_show_self_report:\s*showSelfReportToggle\.checked/);
    expect(fnBody).toMatch(/showInterventions:\s*s\.sra_show_interventions/);
    expect(fnBody).toMatch(/showSelfReport:\s*s\.sra_show_self_report/);
  });

  it('both toggles are wired to saveAndBroadcast on change', () => {
    expect(settingsJs).toMatch(/\[\s*[^\]]*showInterventionsToggle[^\]]*showSelfReportToggle[^\]]*\]\s*\n?\s*\.forEach\(\(el\) => el\.addEventListener\('change', saveAndBroadcast\)\)/);
  });
});

describe('content.js — reads both keys live and threads them into host.js', () => {
  it('declares both flags, defaulting to true', () => {
    expect(contentJs).toMatch(/let showInterventions\s*=\s*true/);
    expect(contentJs).toMatch(/let showSelfReportButton\s*=\s*true/);
  });

  it('the settings() getter passed to createHost includes showInterventions', () => {
    expect(contentJs).toMatch(/settings:\s*\(\)\s*=>\s*\(\{\s*assistantEnabled,\s*backendUrl,\s*showInterventions(?:,\s*showConnections)?\s*\}\)/);
  });

  it('the storage defaults block reads both new keys', () => {
    expect(contentJs).toMatch(/sra_show_interventions:\s*true,\s*sra_show_self_report:\s*true/);
  });

  it('applies the stored self-report value via setShowSelfReportButton once settings load', () => {
    expect(contentJs).toMatch(/showSelfReportButton\s*=\s*res\.sra_show_self_report\s*!==\s*false/);
    expect(contentJs).toMatch(/if\s*\(!showSelfReportButton\)\s*setShowSelfReportButton\(false\)/);
  });

  it('the live settings-message handler updates both flags and re-applies the button setting', () => {
    const branchStart = contentJs.indexOf("if (msg.type === 'settings')");
    const branchBody = contentJs.slice(branchStart, contentJs.indexOf("sendResponse({ status: 'ok' }); return;", branchStart));
    expect(branchBody).toMatch(/if\s*\(msg\.showInterventions\s*!==\s*undefined\)\s*showInterventions\s*=\s*!!msg\.showInterventions/);
    expect(branchBody).toMatch(/if\s*\(msg\.showSelfReport\s*!==\s*undefined\)\s*\{/);
    expect(branchBody).toMatch(/setShowSelfReportButton\(showSelfReportButton\)/);
  });
});

describe('host.js — the gate and the setter this whole feature is built on', () => {
  it('onIntervention, checkRetentionCandidate, checkProbe and checkTransferCandidate all check showInterventions', () => {
    const occurrences = hostJs.match(/s\(\)\.showInterventions === false/g) || [];
    expect(occurrences.length).toBe(4);
  });

  it('exposes setShowSelfReportButton, toggling ensureSelfReportTrigger/removeSelfReportTrigger', () => {
    expect(hostJs).toMatch(/function setShowSelfReportButton\(show\)/);
    expect(hostJs).toMatch(/if \(show\) ui\.ensureSelfReportTrigger\?\.\(showSelfReportCard\);/);
    expect(hostJs).toMatch(/else ui\.removeSelfReportTrigger\?\.\(\);/);
    // Actually returned, not just defined — a dangling local helper would
    // be unreachable from content.js/reading-bridge.js either way.
    expect(hostJs).toMatch(/\n\s*setShowSelfReportButton,\n/);
  });
});

describe('reading-bridge.js — the PDF/document-viewer boot path wires the same two settings', () => {
  it('declares both flags, defaulting to true', () => {
    expect(readingBridgeJs).toMatch(/let showInterventions\s*=\s*true/);
    expect(readingBridgeJs).toMatch(/let showSelfReportButton\s*=\s*true/);
  });

  it('threads showInterventions into createHost\'s own settings() getter', () => {
    expect(readingBridgeJs).toMatch(/settings:\s*\(\)\s*=>\s*\(\{\s*assistantEnabled,\s*backendUrl,\s*showInterventions(?:,\s*showConnections)?\s*\}\)/);
  });

  it('SETTINGS_DEFAULTS includes both new storage keys', () => {
    const block = readingBridgeJs.slice(
      readingBridgeJs.indexOf('const SETTINGS_DEFAULTS'),
      readingBridgeJs.indexOf('};', readingBridgeJs.indexOf('const SETTINGS_DEFAULTS')),
    );
    expect(block).toMatch(/sra_show_interventions:\s*true/);
    expect(block).toMatch(/sra_show_self_report:\s*true/);
  });

  it('applySettings() calls hostApi.setShowSelfReportButton only on a genuine change', () => {
    const fnBody = readingBridgeJs.slice(
      readingBridgeJs.indexOf('function applySettings'),
      readingBridgeJs.indexOf('\n  }', readingBridgeJs.indexOf('function applySettings')),
    );
    expect(fnBody).toMatch(/showInterventions\s*=\s*res\.sra_show_interventions\s*!==\s*false/);
    expect(fnBody).toMatch(/hostApi\.setShowSelfReportButton\(showSelfReportButton\)/);
  });
});
