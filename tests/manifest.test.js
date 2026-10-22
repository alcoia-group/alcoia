/* The manifest differences between Chrome and Firefox, pinned.
 *
 * These are the failures that do not announce themselves: an extension with
 * both `background.service_worker` and `background.scripts` loads in Firefox
 * and silently runs neither reliably; a missing gecko id is rejected at AMO
 * submission rather than at build time; and a hand-edit to the generated
 * alcoia/manifest.json survives locally and vanishes on the next build.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, TARGETS } from '../build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

describe('manifest targets', () => {
  it('builds every declared target', () => {
    for (const t of TARGETS) expect(buildManifest(t).manifest_version).toBe(3);
  });

  it('gives Chrome a service worker and no event page', () => {
    const m = buildManifest('chrome');
    expect(m.background.service_worker).toBe('background.js');
    expect(m.background.scripts).toBeUndefined();
  });

  it('gives Firefox an event page and no service worker', () => {
    // Firefox MV3 has no service_worker support. Shipping both keys is the
    // classic cross-browser manifest bug.
    const m = buildManifest('firefox');
    // config.js must load before background.js — it defines self.ALCOIA_CONFIG,
    // which background.js reads at top level.
    expect(m.background.scripts).toEqual([
      'src/shared/config.js', 'src/shared/sensitive-sites.js', 'src/shared/site-access.js',
      'src/shared/account-sync.js', 'background.js',
    ]);
    expect(m.background.service_worker).toBeUndefined();
  });

  it('gives Firefox an add-on id and a minimum version', () => {
    const g = buildManifest('firefox').browser_specific_settings?.gecko;
    expect(g?.id).toMatch(/^[^@]+@[^@]+$|^\{[0-9a-f-]+\}$/i);
    // 128 is the first ESR where scripting.executeScript({ world: 'MAIN' })
    // and Intl.Segmenter are both present, so nothing has to degrade.
    expect(parseInt(g?.strict_min_version, 10)).toBeGreaterThanOrEqual(128);
  });

  it('does not leak Chrome-only manifest keys into Firefox', () => {
    const m = buildManifest('firefox');
    for (const entry of m.web_accessible_resources || []) {
      expect(entry.use_dynamic_url).toBeUndefined();
    }
  });

  it('keeps content scripts and web-accessible resources identical across targets', () => {
    const [a, b] = TARGETS.map(buildManifest);
    expect(a.content_scripts).toEqual(b.content_scripts);
    expect(a.web_accessible_resources).toEqual(b.web_accessible_resources);
    expect(a.permissions).toEqual(b.permissions);
    expect(a.host_permissions).toEqual(b.host_permissions);
  });

  it('keeps the committed dev manifest in step with its sources', () => {
    // alcoia/manifest.json is generated. If this fails, someone edited it by
    // hand — move the change into manifests/ and re-run `npm run build`.
    expect(read('alcoia/manifest.json')).toEqual(buildManifest('chrome'));
  });

  it('matches the version in package.json', () => {
    expect(buildManifest('chrome').version).toBe(read('package.json').version);
  });
});

/* The backend origin used to be hardcoded in four places (content.js,
 * background.js, popup.js, popup.html) plus two loopback entries in
 * host_permissions here. All four now read src/shared/config.js; this pins
 * that they stay in sync and that dev-only loopback access never ships. */
describe('backend origin configuration', () => {
  it('ships no localhost or loopback host permission', () => {
    for (const target of TARGETS) {
      const m = buildManifest(target);
      for (const entry of m.host_permissions || []) {
        expect(entry).not.toMatch(/localhost|127\.0\.0\.1/);
      }
    }
  });

  it('defines the origin in exactly one shared config file', () => {
    const config = fs.readFileSync(path.join(ROOT, 'alcoia/src/shared/config.js'), 'utf8');
    expect(config).toMatch(/BACKEND_ORIGIN\s*=/);
  });

  it('resolves all four code sites to the same origin', () => {
    const config = fs.readFileSync(path.join(ROOT, 'alcoia/src/shared/config.js'), 'utf8');
    const [, origin] = config.match(/BACKEND_ORIGIN\s*=\s*'([^']+)'/) || [];
    expect(origin).toBeTruthy();

    const content = fs.readFileSync(path.join(ROOT, 'alcoia/src/content/content.js'), 'utf8');
    expect(content).toMatch(/BACKEND_DEFAULT\s*=\s*self\.ALCOIA_CONFIG\.SUMMARIZE_URL/);

    const background = fs.readFileSync(path.join(ROOT, 'alcoia/background.js'), 'utf8');
    expect(background).toMatch(/self\.ALCOIA_CONFIG\.SUMMARIZE_URL/);

    // Item 15a-1: popup.js no longer holds its own copy of this default —
    // it stopped broadcasting settings to content.js entirely (settings.js
    // owns that now, the sole place a settings message is composed and
    // sent). settings.js's own DEFAULTS is what has to match config.js.
    const settingsJs = fs.readFileSync(path.join(ROOT, 'alcoia/src/popup/settings.js'), 'utf8');
    expect(settingsJs).toMatch(/sra_backend_url:\s*self\.ALCOIA_CONFIG\.SUMMARIZE_URL/);

    const popupHtml = fs.readFileSync(path.join(ROOT, 'alcoia/src/popup/popup.html'), 'utf8');
    expect(popupHtml).toMatch(/src="\.\.\/shared\/config\.js"/);
    expect(popupHtml).not.toMatch(/localhost:3000/);

    const settingsHtml = fs.readFileSync(path.join(ROOT, 'alcoia/src/popup/settings.html'), 'utf8');
    expect(settingsHtml).toMatch(/src="\.\.\/shared\/config\.js"/);
    expect(settingsHtml).not.toMatch(/localhost:3000/);

    // Item 33: the editable backend-URL field moved to the diagnostics page
    // (developer-only, sra_debug-gated) — popup.js/popup.html no longer show
    // it at all, so the placeholder-from-config check moves with it.
    const diagnosticsJs = fs.readFileSync(path.join(ROOT, 'alcoia/src/popup/diagnostics.js'), 'utf8');
    expect(diagnosticsJs).toMatch(/devBackendUrl'\)\.placeholder\s*=\s*self\.ALCOIA_CONFIG\.SUMMARIZE_URL/);
    const diagnosticsHtml = fs.readFileSync(path.join(ROOT, 'alcoia/src/popup/diagnostics.html'), 'utf8');
    expect(diagnosticsHtml).toMatch(/src="\.\.\/shared\/config\.js"/);

    // No file goes back to hardcoding the origin instead of reading config.
    for (const [label, text] of [['content.js', content], ['background.js', background], ['settings.js', settingsJs], ['diagnostics.js', diagnosticsJs]]) {
      expect(text, `${label} should not hardcode localhost:3000`).not.toMatch(/http:\/\/localhost:3000/);
    }
  });

  it('loads config.js before the file that reads it, in every manifest entry point', () => {
    const base = read('manifests/base.json');
    expect(base.content_scripts[0].js.indexOf('src/shared/config.js'))
      .toBeLessThan(base.content_scripts[0].js.indexOf('src/content/content.js'));

    const firefox = read('manifests/firefox.json');
    expect(firefox.background.scripts.indexOf('src/shared/config.js'))
      .toBeLessThan(firefox.background.scripts.indexOf('background.js'));

    const popupHtml = fs.readFileSync(path.join(ROOT, 'alcoia/src/popup/popup.html'), 'utf8');
    expect(popupHtml.indexOf('shared/config.js')).toBeLessThan(popupHtml.indexOf('popup.js"></script>'));
  });
});

/* Package hygiene: the shipped package used to carry no LICENSE at all, and
 * all four icon sizes pointed at one PNG rescaled by the browser. Importing
 * build.mjs above already ran the build as a side effect, so the dist output
 * exists by the time these run. */
describe('package hygiene', () => {
  it('ships a LICENSE file in every target', () => {
    for (const target of TARGETS) {
      const p = path.join(ROOT, 'dist', target, 'LICENSE');
      expect(fs.existsSync(p), `dist/${target}/LICENSE should exist`).toBe(true);
      expect(fs.readFileSync(p, 'utf8').length).toBeGreaterThan(0);
    }
  });

  it('points 16, 48 and 128 at three distinct icon files', () => {
    for (const target of TARGETS) {
      const m = buildManifest(target);
      for (const iconSet of [m.icons, m.action.default_icon]) {
        const files = new Set([iconSet['16'], iconSet['48'], iconSet['128']]);
        expect(files.size, 'icons at 16/48/128 should not share one file').toBe(3);
      }
    }
  });

  it('ships the icon files it declares', () => {
    for (const target of TARGETS) {
      const m = buildManifest(target);
      for (const rel of Object.values(m.icons)) {
        const p = path.join(ROOT, 'dist', target, rel);
        expect(fs.existsSync(p), `dist/${target}/${rel} should exist`).toBe(true);
      }
    }
  });
});

/* Permissions. alcoia reads nothing on a site the reader has not switched on, so install time grants only
 * the alcoia sites. Everything else is an optional host permission, and a registered content script follows
 * what the reader granted (src/shared/site-access.js). */
describe('permissions', () => {
  it('asks at install for the alcoia sites only', () => {
    for (const target of TARGETS) {
      const m = buildManifest(target);
      expect(m.host_permissions).toEqual(['https://server.alcoia.app/*', 'https://workspace.alcoia.app/*', 'https://alcoia.app/*']);
      expect(m.host_permissions).not.toContain('<all_urls>');
      expect(m.host_permissions).not.toContain('file:///*');
    }
  });

  it('keeps all other sites and local files as optional host permissions', () => {
    for (const target of TARGETS) {
      expect(buildManifest(target).optional_host_permissions).toEqual(['<all_urls>', 'file:///*']);
    }
  });

  it('injects the static content script only on the alcoia sites', () => {
    for (const target of TARGETS) {
      const [cs] = buildManifest(target).content_scripts;
      expect(cs.matches).toEqual(['https://alcoia.app/*', 'https://workspace.alcoia.app/*']);
      expect(cs.matches).not.toContain('<all_urls>');
    }
  });

  it('loads the sensitive-site list before the content script that reads it', () => {
    const js = read('manifests/base.json').content_scripts[0].js;
    expect(js.indexOf('src/shared/sensitive-sites.js')).toBeGreaterThan(-1);
    expect(js.indexOf('src/shared/sensitive-sites.js')).toBeLessThan(js.indexOf('src/content/content.js'));
  });

  it('declares scripting and no tabs or webNavigation permission', () => {
    for (const target of TARGETS) {
      const perms = buildManifest(target).permissions;
      expect(perms).toContain('scripting');
      expect(perms).not.toContain('tabs');
      expect(perms).not.toContain('webNavigation');
    }
  });

  it('does not use webNavigation in the worker', () => {
    const bg = fs.readFileSync(path.join(ROOT, 'alcoia/background.js'), 'utf8');
    expect(bg).not.toMatch(/chrome\.webNavigation/);
  });

  it('does not let any page but alcoia.app message the extension', () => {
    const m = buildManifest('chrome');
    expect(m.externally_connectable.matches).toEqual(['https://alcoia.app/*']);
    expect(JSON.stringify(m)).not.toMatch(/alcoia\.invalid/);
  });

  it('ships the new page and shared scripts in the package', () => {
    for (const target of TARGETS) {
      for (const rel of ['src/popup/welcome.html', 'src/shared/sensitive-sites.js', 'src/shared/site-access.js']) {
        expect(fs.existsSync(path.join(ROOT, 'dist', target, rel)), `${target}/${rel}`).toBe(true);
      }
    }
  });
});
