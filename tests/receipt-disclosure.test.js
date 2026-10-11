import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The join notice is the promise a student reads before joining. These checks pin what it says about reading
// receipts: what one can contain, what it does and does not prove, and that nothing is sent automatically.
const html = readFileSync(resolve(import.meta.dirname, '../alcoia/src/popup/join-class.html'), 'utf8');
const block = (id) => {
  const start = html.indexOf(`id="${id}"`);
  const end = html.indexOf('</div>', start);
  return html.slice(start, end).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
};
const anonymous = block('disclosureAnonymous');
const identified = block('disclosureIdentified');

describe.each([['anonymous', anonymous], ['identified', identified]])('%s join notice, reading receipts', (_name, text) => {
  it('lists what a receipt can contain', () => {
    expect(text).toMatch(/how long the session lasted|session length/i);
    expect(text).toMatch(/reading-interaction measures/i);
    expect(text).toMatch(/tab-blur counts/i);
    expect(text).toMatch(/questions Alcoia asked you and what happened to each/i);
    expect(text).toMatch(/per-question timing and how many times you changed your answer/i);
    expect(text).toMatch(/short excerpts \(up to 180 characters\)/i);
  });
  it('says a receipt shows only that it is unaltered since issue, and does not prove reading or understanding', () => {
    expect(text).toMatch(/has not been altered since Alcoia issued it/i);
    expect(text).toMatch(/does not independently prove that you read or understood the document/i);
    expect(text).not.toMatch(/\b(verified|authentic|proof that you read)\b/i);
  });
  it('does not claim a receipt is submitted automatically, and says Alcoia sends none on its own', () => {
    expect(text).toMatch(/does not send one anywhere on its own/i);
    expect(text).not.toMatch(/automatically (submitted|sent|shared)|submitted automatically/i);
  });
});

describe('what each mode says the instructor sees of a receipt', () => {
  it('anonymous: the console does not show submitted receipts; a receipt handed over elsewhere is seen in full', () => {
    expect(anonymous).toMatch(/aggregate results only/i);
    expect(anonymous).toMatch(/instructor console does not show submitted receipts/i);
    expect(anonymous).toMatch(/some other way, they can see everything in it/i);
    expect(anonymous).not.toMatch(/instructor sees that one receipt/i);
  });
  it('identified: a submitted receipt is seen with the student\'s name', () => {
    expect(identified).toMatch(/individual results/i);
    expect(identified).toMatch(/instructor can see it with your name/i);
  });
});
