import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'alcoia/src/popup/upgrade.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'alcoia/src/popup/upgrade.js'), 'utf8');
const list = (name) => {
  const start = html.indexOf(`<div class="tier-name">${name}`);
  const end = html.indexOf('</ul>', start);
  return [...html.slice(start, end).matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
};

describe('plans page', () => {
  it('states no usage limits', () => {
    for (const text of [html, js]) {
      expect(text).not.toMatch(/AI assists?/i);
      expect(text).not.toMatch(/unlimited/i);
      expect(text).not.toMatch(/\b(150|300)\b.*checks?/i);
      expect(text).not.toMatch(/checks? (a|per) month/i);
    }
  });

  it('lists Reader as Free plus the five plan-gated things', () => {
    expect(list('Reader')).toEqual([
      'Everything in Free', 'Cross-document intelligence', 'Reading analytics', 'File upload', 'Exam Mode', 'Same plan on every device',
    ]);
    expect(html).not.toMatch(/>Sync</);
    expect(html).not.toMatch(/Cross-device sync/);
  });

  it('puts what is free on the Free list, with PDF and PowerPoint named in full', () => {
    const free = list('Free');
    for (const item of ['Retrieval questions', 'Session recall', 'Reading receipts', 'PDF and PowerPoint files', 'Dyslexia mode']) expect(free).toContain(item);
    expect(html).not.toMatch(/PDF and PPTX/);
  });

  it('matches the prices on the marketing pricing page', () => {
    expect(js).toContain("annual:  { amount: '$4.92', unit: '/mo', note: '$59 billed annually' }");
    expect(js).toMatch(/monthly: \{ amount: '\$6\.99'/);
    expect(html).toContain('$4<span class="unit">/seat/mo</span>');
    expect(html).toContain('$29 a year or $3.99 a month');
    expect(html).not.toMatch(/40% off/);
    expect(html).not.toMatch(/months free/);
  });
});
