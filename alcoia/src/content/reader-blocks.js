/* reader-blocks.js — paragraph source for the alcoia workspace's PDFs.
 *
 * On the workspace app (workspace.alcoia.app) Word and PowerPoint documents
 * are real <p>/<li> markup, so the content script's ordinary DOM scan reads
 * them unchanged. A PDF is different: pdf.js draws the page to a canvas and
 * lays a transparent .textLayer of <span>s over it, one span per text run, so
 * there are no paragraphs in the DOM. This turns those spans into the same
 * paragraph blocks the PDF viewer's reading-bridge.js feeds the tracker, using
 * the same grouping (pdf-handler.js's groupTextLayerParagraphs).
 *
 * The returned function is paragraph-tracker.js's `blockSource`. It returns
 * `null` when the page has no text layer, which tells the tracker to scan the
 * DOM as usual, so one source serves every format the reader shows.
 *
 * Each paragraph is a detached <span> carrying the real text (identity is
 * cached per paragraph id, so the tracker does not see a "new" paragraph every
 * scan) with a getBoundingClientRect() that measures the live text spans.
 */
import { groupTextLayerParagraphs, unionRect } from './pdf-handler.js';
import { countWords, detectLanguage } from './signals/segmentation.js';

export function createReaderBlockSource(doc = document) {
  const elCache = new Map();
  return function readerBlockSource() {
    if (!doc.querySelector('.textLayer span')) return null;
    const groups = groupTextLayerParagraphs(doc);
    const lang = detectLanguage(doc);
    const seen = new Set();
    const blocks = groups.map((g) => {
      seen.add(g.id);
      let el = elCache.get(g.id);
      if (!el || el.textContent !== g.text) {
        el = doc.createElement('span');
        el.textContent = g.text;
        elCache.set(g.id, el);
      }
      el.getBoundingClientRect = () => unionRect(g.spans);
      return { el, words: countWords(g.text, lang), media: false };
    });
    for (const id of [...elCache.keys()]) { if (!seen.has(id)) elCache.delete(id); }
    return blocks;
  };
}
