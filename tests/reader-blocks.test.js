// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createReaderBlockSource } from '../alcoia/src/content/reader-blocks.js';

function textLayerPage(lines) {
  document.body.innerHTML = '<div class="textLayer"></div>';
  const layer = document.querySelector('.textLayer');
  lines.forEach((text, i) => {
    const sp = document.createElement('span');
    sp.textContent = text;
    sp.getBoundingClientRect = () => ({ top: 100 + i * 14, bottom: 112 + i * 14, left: 10, right: 400, width: 390, height: 12 });
    layer.appendChild(sp);
  });
}
const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

describe('createReaderBlockSource', () => {
  it('answers null when the page has no text layer (Word, PowerPoint: scan the DOM)', () => {
    document.body.innerHTML = '<p>Just a paragraph</p>';
    expect(createReaderBlockSource(document)()).toBeNull();
  });
  it('groups text-layer lines into paragraph blocks with stable identity', () => {
    textLayerPage([words(12), words(12)]);
    const source = createReaderBlockSource(document);
    const a = source();
    expect(a).toHaveLength(1);
    expect(a[0].words).toBeGreaterThanOrEqual(20);
    expect(a[0].el.textContent).toContain('word0');
    expect(source()[0].el).toBe(a[0].el);
  });
});
