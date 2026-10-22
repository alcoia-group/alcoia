/* The shipped extension asks for no access to ordinary sites at install; the reader switches sites on one by
 * one. A scripted browser cannot click the permission prompt, so the browser checks load a COPY of the
 * extension whose manifest grants every site up front. Nothing else is changed: same files, same scripts. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function prepareTestExtension(srcDir) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'alcoia-ext-'));
  fs.cpSync(srcDir, out, { recursive: true });
  const mp = path.join(out, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  m.host_permissions = Array.from(new Set([...(m.host_permissions || []), '<all_urls>']));
  m.content_scripts[0].matches = ['<all_urls>'];
  fs.writeFileSync(mp, JSON.stringify(m, null, 2));
  return out;
}
