// @vitest-environment jsdom
/* pdf-handler.js gained two new, pure, stateless exports in item 30c —
 * groupTextLayerParagraphs() and unionRect() — factored out of the existing
 * indexTextLayers() so alcoia's own PDF viewer (reading-bridge.js) can feed
 * paragraph-tracker.js's injected block source (item 30b) with LIVE,
 * re-callable results, rather than going through initPDFHandler()'s
 * one-shot `parsed` latch built for a different use (manual Alt+S-style
 * point lookup on an arbitrary page embedding a foreign PDF viewer).
 *
 * This file covers the two new exports directly, plus a regression check
 * that initPDFHandler()'s own existing findParagraphAt()/getParagraphText()
 * behaviour — already verified end to end in a real Chromium load per
 * the project notes' "pdf-handler.js / pptx-handler.js" section — is unchanged now
 * that indexTextLayers() is implemented on top of the shared export instead
 * of duplicating the grouping algorithm inline.
 */
import { describe, it, expect } from 'vitest';
import { groupTextLayerParagraphs, unionRect, initPDFHandler } from '../alcoia/src/content/pdf-handler.js';

/* Builds a real .textLayer div with real <span> children, each given a
 * fixed getBoundingClientRect() — jsdom lays out nothing, so every rect used
 * anywhere in these tests is supplied explicitly, the same way
 * tests/signal-detectors.test.js's fakeDocument() stubs paragraph-tracker.js's
 * own DOM reads. */
function buildTextLayer(container, spanRects) {
  const layer = document.createElement('div');
  layer.className = 'textLayer';
  spanRects.forEach(({ text, top, left = 0, width = 100, height = 16 }) => {
    const span = document.createElement('span');
    span.textContent = text;
    span.getBoundingClientRect = () => ({
      left, top, right: left + width, bottom: top + height, width, height,
    });
    layer.appendChild(span);
  });
  container.appendChild(layer);
  return layer;
}

describe('groupTextLayerParagraphs()', () => {
  it('returns an empty array with no .textLayer in the document', () => {
    document.body.innerHTML = '';
    expect(groupTextLayerParagraphs(document)).toEqual([]);
  });

  it('groups spans on the same line (within 6px of top) into one line', () => {
    document.body.innerHTML = '';
    buildTextLayer(document.body, [
      { text: 'Hello', top: 100, left: 0 },
      { text: 'world', top: 102, left: 60 },   // same line, 2px off
    ]);
    const groups = groupTextLayerParagraphs(document);
    expect(groups).toHaveLength(1);
    expect(groups[0].text).toBe('Hello world');
  });

  it('merges consecutive lines less than 12px apart into one paragraph', () => {
    document.body.innerHTML = '';
    buildTextLayer(document.body, [
      { text: 'Line one', top: 100 },
      { text: 'Line two', top: 118 },   // bottom of line one (~116) + <12px gap
    ]);
    const groups = groupTextLayerParagraphs(document);
    expect(groups).toHaveLength(1);
    expect(groups[0].text).toBe('Line one\nLine two');
  });

  it('starts a new paragraph when the vertical gap is 12px or more', () => {
    document.body.innerHTML = '';
    buildTextLayer(document.body, [
      { text: 'Paragraph one', top: 100 },
      { text: 'Paragraph two', top: 140 },   // well past the merge threshold
    ]);
    const groups = groupTextLayerParagraphs(document);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.text)).toEqual(['Paragraph one', 'Paragraph two']);
  });

  it('assigns sequential pdf-p-N ids in reading order', () => {
    document.body.innerHTML = '';
    buildTextLayer(document.body, [
      { text: 'A', top: 100 },
      { text: 'B', top: 140 },
      { text: 'C', top: 180 },
    ]);
    const groups = groupTextLayerParagraphs(document);
    expect(groups.map((g) => g.id)).toEqual(['pdf-p-0', 'pdf-p-1', 'pdf-p-2']);
  });

  it('skips spans with no text content', () => {
    document.body.innerHTML = '';
    buildTextLayer(document.body, [
      { text: '   ', top: 100 },
      { text: 'Real text', top: 140 },
    ]);
    const groups = groupTextLayerParagraphs(document);
    expect(groups).toHaveLength(1);
    expect(groups[0].text).toBe('Real text');
  });

  it('keeps live span references so a caller can re-measure them later', () => {
    document.body.innerHTML = '';
    buildTextLayer(document.body, [{ text: 'A', top: 100 }]);
    const [group] = groupTextLayerParagraphs(document);
    expect(group.spans).toHaveLength(1);
    expect(group.spans[0].textContent).toBe('A');
  });

  it('is re-callable and reflects DOM changes between calls (the "live" contract)', () => {
    document.body.innerHTML = '';
    buildTextLayer(document.body, [{ text: 'First paragraph', top: 100 }]);
    expect(groupTextLayerParagraphs(document)).toHaveLength(1);

    buildTextLayer(document.body, [{ text: 'Second layer paragraph', top: 400 }]);
    const groups = groupTextLayerParagraphs(document);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.text)).toEqual(['First paragraph', 'Second layer paragraph']);
  });
});

describe('unionRect()', () => {
  it('returns the union bounding box of several spans', () => {
    const spans = [
      { getBoundingClientRect: () => ({ left: 10, top: 10, right: 60, bottom: 26, width: 50, height: 16 }) },
      { getBoundingClientRect: () => ({ left: 70, top: 12, right: 120, bottom: 28, width: 50, height: 16 }) },
    ];
    const r = unionRect(spans);
    expect(r).toEqual({ left: 10, top: 10, right: 120, bottom: 28, width: 110, height: 18 });
  });

  it('returns a zero rect for an empty span list', () => {
    expect(unionRect([])).toEqual({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  });

  it('skips a span whose getBoundingClientRect() throws (e.g. detached mid-read)', () => {
    const spans = [
      { getBoundingClientRect: () => { throw new Error('detached'); } },
      { getBoundingClientRect: () => ({ left: 5, top: 5, right: 25, bottom: 15, width: 20, height: 10 }) },
    ];
    expect(unionRect(spans)).toEqual({ left: 5, top: 5, right: 25, bottom: 15, width: 20, height: 10 });
  });

  it('skips zero-size spans', () => {
    const spans = [
      { getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }) },
      { getBoundingClientRect: () => ({ left: 5, top: 5, right: 25, bottom: 15, width: 20, height: 10 }) },
    ];
    expect(unionRect(spans)).toEqual({ left: 5, top: 5, right: 25, bottom: 15, width: 20, height: 10 });
  });

  it('recomputes fresh on every call rather than caching', () => {
    let currentLeft = 0;
    const spans = [{ getBoundingClientRect: () => ({ left: currentLeft, top: 0, right: currentLeft + 10, bottom: 10, width: 10, height: 10 }) }];
    expect(unionRect(spans).left).toBe(0);
    currentLeft = 50;
    expect(unionRect(spans).left).toBe(50);
  });
});

describe('initPDFHandler(): existing manual-lookup behaviour unchanged by the refactor', () => {
  it('findParagraphAt() locates the real .textLayer-derived paragraph at a point', async () => {
    document.body.innerHTML = '';
    buildTextLayer(document.body, [
      { text: 'First paragraph text', top: 100, left: 0, width: 200, height: 16 },
      { text: 'Second paragraph text', top: 200, left: 0, width: 200, height: 16 },
    ]);
    const handler = await initPDFHandler();
    const hit = await handler.findParagraphAt(50, 105);
    expect(hit).toBeTruthy();
    expect(hit.text).toBe('First paragraph text');
  });

  it('findParagraphAt() returns null when no paragraph is near the point', async () => {
    document.body.innerHTML = '';
    buildTextLayer(document.body, [{ text: 'Only paragraph', top: 100, left: 0, width: 200, height: 16 }]);
    const handler = await initPDFHandler();
    const hit = await handler.findParagraphAt(9999, 9999);
    expect(hit).toBeNull();
  });

  it('getParagraphText() returns the indexed paragraph text', async () => {
    document.body.innerHTML = '';
    buildTextLayer(document.body, [{ text: 'Readable text here', top: 100, left: 0, width: 200, height: 16 }]);
    const handler = await initPDFHandler();
    const hit = await handler.findParagraphAt(50, 105);
    expect(await handler.getParagraphText(hit)).toBe('Readable text here');
  });

  it('getParagraphText() returns an empty string for null input', async () => {
    document.body.innerHTML = '';
    const handler = await initPDFHandler();
    expect(await handler.getParagraphText(null)).toBe('');
  });
});
