/* Item 21 found three extension pages whose entire logic sat in an inline
 * <script> block, which MV3's default extension-page CSP (script-src 'self',
 * no override in manifests/base.json) blocks outright. No error, no thrown
 * exception — the page just renders and does nothing, this codebase's
 * recurring failure shape. This is the guard against a fourth occurrence:
 * every shipped .html file must load its logic from an external file, and
 * must not rely on an inline event-handler attribute, which the same CSP
 * also blocks. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'alcoia');

function findHtmlFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findHtmlFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.html')) found.push(full);
  }
  return found;
}

const htmlFiles = findHtmlFiles(ROOT);

// Inline event-handler attributes the same script-src CSP directive blocks.
const INLINE_HANDLER = /\son(click|change|submit|input|load|error|mouseover|mouseout|keydown|keyup|focus|blur)\s*=/i;

describe('no inline scripts (MV3 CSP blocks them silently)', () => {
  it('found at least one shipped .html file to check', () => {
    expect(htmlFiles.length).toBeGreaterThan(0);
  });

  for (const file of htmlFiles) {
    const rel = path.relative(ROOT, file);
    const html = fs.readFileSync(file, 'utf8');

    it(`${rel} has no inline <script> block`, () => {
      // A <script ...> tag with no src= attribute is inline. Matches the
      // opening tag only — this is a content check, not an HTML parse.
      const openTags = html.match(/<script\b[^>]*>/gi) || [];
      const inlineTags = openTags.filter((tag) => !/\ssrc\s*=/i.test(tag));
      expect(inlineTags).toEqual([]);
    });

    it(`${rel} has no inline event-handler attribute`, () => {
      expect(INLINE_HANDLER.test(html)).toBe(false);
    });
  }
});
