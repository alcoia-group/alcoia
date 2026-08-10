/* build.mjs — produce a loadable extension package per browser.
 *
 * This repository deliberately had no build step, and that was right while
 * there was one target. Firefox forces the issue: its MV3 uses an event page
 * (`background.scripts`) where Chrome uses a service worker, and it requires
 * `browser_specific_settings.gecko.id`. Those cannot both live in one file.
 *
 * What this is not: a bundler. Nothing is transpiled, minified or rewritten.
 * The source tree is copied verbatim and only `manifest.json` differs between
 * targets. If this script ever starts touching JavaScript, something has gone
 * wrong.
 *
 *   node build.mjs             both targets
 *   node build.mjs firefox     one target
 *
 * `alcoia/manifest.json` is *generated* from manifests/base.json +
 * manifests/chrome.json so that loading `alcoia/` unpacked still works for
 * day-to-day development without running a build first. It is committed, and
 * tests/manifest.test.js fails if it drifts from its sources — otherwise
 * somebody edits the generated file, the change survives locally, and the
 * next build silently reverts it.
 */
import fs from 'node:fs';     
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'alcoia');
const DIST = path.join(HERE, 'dist');
const MANIFESTS = path.join(HERE, 'manifests');

export const TARGETS = ['chrome', 'firefox'];

/* Excluded from the shipped package.
 *
 * `server/` matters most: it lives inside alcoia/ for convenience but it is a
 * separate program, it is not covered by the AGPL grant, and it holds the
 * prompts and the .env. Zipping it into a store submission would publish all
 * three. */
const EXCLUDE = new Set(['server', 'README.md', '.env', '.env.example', 'node_modules']);

export function buildManifest(target) {
  const base = JSON.parse(fs.readFileSync(path.join(MANIFESTS, 'base.json'), 'utf8'));
  const patch = JSON.parse(fs.readFileSync(path.join(MANIFESTS, `${target}.json`), 'utf8'));
  // A shallow merge is deliberate: every key a target overrides, it overrides
  // whole. Deep-merging `background` would leave Firefox with both a
  // service_worker and a scripts array, which is exactly the bug this file
  // exists to prevent.
  return { ...base, ...patch };
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    if (entry.name === 'manifest.json') continue;  // written per target below
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

function build(target) {
  const out = path.join(DIST, target);
  fs.rmSync(out, { recursive: true, force: true });
  copyTree(SRC, out);
  const manifest = buildManifest(target);
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  let files = 0;
  (function count(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) count(path.join(dir, e.name));
      else files++;
    }
  })(out);
  console.log(`  ${target.padEnd(8)} → dist/${target}  (${files} files)`);
}

const targets = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const chosen = targets.length ? targets : TARGETS;

for (const t of chosen) {
  if (!TARGETS.includes(t)) {
    console.error(`unknown target "${t}" — expected one of ${TARGETS.join(', ')}`);
    process.exit(1);
  }
}

console.log('building alcoia');
for (const t of chosen) build(t);

// Keep the unpacked dev copy in step with its sources.
fs.writeFileSync(
  path.join(SRC, 'manifest.json'),
  JSON.stringify(buildManifest('chrome'), null, 2) + '\n',
);
console.log('  alcoia/manifest.json regenerated (chrome, for unpacked development)');
