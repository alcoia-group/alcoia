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
    expect(m.background.scripts).toEqual(['background.js']);
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
