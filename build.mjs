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
const LICENSE = path.join(HERE, 'LICENSE');

export const TARGETS = ['chrome', 'firefox'];

/* manifests/base.json's `externally_connectable.matches` — JSON cannot hold
 * a comment, so the explanation lives here instead. It is currently
 * 'http://localhost:5173/*', a DEV VALUE: the Phase 1 landing page
 * (alcoiaWeb, a separate repo) that hands this extension a magic-link
 * sign-in code via chrome.runtime.sendMessage(). alcoia.app does not
 * resolve yet — the whole roadmap is designed to work without it — so this
 * MUST be swapped to 'https://alcoia.app/*' before any real launch, and
 * src/shared/config.js's WEB_APP_ORIGIN constant (the runtime origin check
 * background.js's onMessageExternal listener does, independent of this
 * manifest entry) must be swapped to match at the same time — the two are
 * not wired together and a mismatch would make one of them wrong silently.
 * The port here is Vite's default and a GUESS at what alcoiaWeb actually
 * runs on locally; confirm against that repo's own dev server output.
 *
 * A second entry, 'https://console.alcoia.invalid/*', was added for the
 * LTI launch flow (item S6/E4 follow-up) — the page a Canvas launch
 * actually lands a student's browser on, which hands the extension either
 * a pending-disclosure signal or an already-minted session. That page
 * does not exist in any repo available here either; the value is copied
 * verbatim from alcoiaServer's own default for ltiReaderBaseUrl
 * (src/http/routes/lti.js), not invented, and src/shared/config.js's
 * LTI_READER_ORIGIN must be swapped to match at the same time this entry
 * is, for the same "not wired together" reason as WEB_APP_ORIGIN above. */

/* Excluded from the shipped package.
 *
 * `server/` used to be the entry that mattered most here — it lived inside
 * `alcoia/` for convenience but was a separate, un-AGPL-covered program that
 * held prompts and a `.env`. It has since moved out entirely, to a separate
 * private repo (see CLAUDE.md, "Migration in progress"), so there is nothing
 * left under `alcoia/` for that entry to match. This set stays for whatever
 * lands under `alcoia/` next that shouldn't ship. */
const EXCLUDE = new Set(['README.md', '.env', '.env.example', 'node_modules']);

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

  // The shipped package used to carry no LICENSE at all — AGPL-3.0 covers
  // the client, but nothing said so inside dist/*/. Copied here rather than
  // duplicated into alcoia/ itself, so there is exactly one LICENSE file to
  // keep current rather than two that can drift apart.
  fs.copyFileSync(LICENSE, path.join(out, 'LICENSE'));

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
