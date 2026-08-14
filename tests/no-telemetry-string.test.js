/* Item 35: src/content/telemetry/ was renamed to src/content/signals/ because
 * this repository is public for transparency, and "telemetry" reads as
 * surveillance in a source tree a reader can browse — this product's whole
 * pitch is that there is no hidden collection. The rename touched every
 * identifier, import path, comment and doc mention found at the time; this
 * guards against a straggler (or a future PR) reintroducing the word into
 * anything actually shipped. src/libs/ is third-party code (pdf.js, JSZip,
 * bundled fonts) and is exempt — this repo does not control its wording. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'alcoia');
const CHECK_EXT = new Set(['.js', '.mjs', '.html', '.json', '.css']);

function findShippedFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'libs') continue; // third-party, not ours to reword
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findShippedFiles(full));
    else if (CHECK_EXT.has(path.extname(entry.name))) found.push(full);
  }
  return found;
}

const shippedFiles = findShippedFiles(ROOT);

describe('no shipped file says "telemetry" (item 35: renamed to reading signals)', () => {
  it('found at least one shipped file to check', () => {
    expect(shippedFiles.length).toBeGreaterThan(0);
  });

  for (const file of shippedFiles) {
    const rel = path.relative(ROOT, file);
    it(`${rel} does not contain "telemetry"`, () => {
      const text = fs.readFileSync(file, 'utf8');
      expect(text.toLowerCase()).not.toContain('telemetry');
    });
  }
});
