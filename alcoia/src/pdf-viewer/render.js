/* render.js — device-pixel-aware page rendering (item 39, problem 1).
 *
 * The bug this file exists to fix: canvas.width/height were set to the
 * viewport's CSS-pixel size with no devicePixelRatio accounting, so on any
 * display where dpr > 1 the browser upscaled that bitmap to fill its CSS
 * box — visible blur. Chrome's own PDF viewer renders at device
 * resolution; this file makes alcoia's do the same.
 *
 * The rule that must never be broken here: the CANVAS backing store scales
 * by devicePixelRatio, but the TEXT LAYER stays in CSS pixels. The text
 * layer is positioned against the viewport (CSS pixels), not the backing
 * store (device pixels) — scaling it by dpr would misalign every span
 * against the glyphs it sits over, silently breaking selection,
 * highlighting, word lookup and paragraph-tracker.js's item-30c feed all at
 * once, on any display above 1x. Both this file's own tests and the
 * two-column PDF check in the smoke suite exist specifically to catch that
 * regression before it ships quietly on a retina/4K screen a 1x-only dev
 * machine would never surface.
 */

// A per-page cap on the backing store's device-pixel area (width x height in
// actual bitmap pixels, not CSS pixels), so a large page at a high zoom on a
// 3x display cannot exhaust memory. 4096x4096 (~16.8M px) is the ceiling:
// it is comfortably inside the safe canvas/texture size every mainstream
// GPU and browser supports (well below the ~32k-per-side limits that start
// causing outright failures), and at 4 bytes/px (RGBA) that is ~67MB for
// one page's backing store — even the small-document path, which renders
// every page up front (see viewer.js, <=20 pages), stays within roughly a
// low-single-digit-GB budget in the worst case, nowhere near a renderer's
// practical OOM ceiling. It only ever engages for the described edge case;
// an ordinary page at 1x-2x and a sane zoom never gets close to it.
export const MAX_BACKING_STORE_PX = 4096 * 4096;

/* Renders one page into `container`: a dpr-scaled <canvas> plus a CSS-pixel
 * <div class="textLayer">, both built from the SAME unscaled viewport object
 * so they can never drift apart. Returns the page wrapper element once both
 * the canvas paint and the text layer's own span population have finished —
 * callers that need the text layer's actual spans (reading-bridge.js,
 * pdf-highlights.js) can rely on it being fully populated by the time this
 * resolves, the same guarantee item 30c already depended on here. */
export async function renderPage(pdfDoc, num, { scale, rotation, container, dpr }) {
  const page = await pdfDoc.getPage(num);
  const vp   = page.getViewport({ scale, rotation }); // CSS pixels — the one true layout viewport

  const wrap = document.createElement('div');
  wrap.className = 'page-wrap';
  wrap.dataset.page = num;

  const canvas = document.createElement('canvas');
  const outputScale = clampToBackingStoreCap(vp.width, vp.height, dpr || 1);
  canvas.width  = Math.max(1, Math.round(vp.width  * outputScale));
  canvas.height = Math.max(1, Math.round(vp.height * outputScale));
  // The CSS box stays at the untouched CSS-pixel viewport size — this is
  // what keeps layout (and therefore the text layer, which is sized off
  // the same vp below) completely unaffected by the backing-store scale.
  canvas.style.width  = vp.width  + 'px';
  canvas.style.height = vp.height + 'px';
  const ctx = canvas.getContext('2d');

  // The scale is handed to pdf.js as a render transform rather than applied
  // via ctx.scale() after the fact — the transform composes with pdf.js's
  // own internal matrix before rasterising, where a post-hoc ctx.scale()
  // would not reliably. `undefined` (identity) when outputScale is 1 keeps
  // the exact-1x path byte-for-byte what it was before this change.
  const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;
  await page.render({ canvasContext: ctx, viewport: vp, transform }).promise;

  const textContent = await page.getTextContent();
  const textLayer = document.createElement('div');
  textLayer.className = 'textLayer';
  // CSS pixels, matching canvas.style.width/height above and vp itself —
  // never the device-pixel backing store size. This is the line that must
  // never read `canvas.width`/`canvas.height` or `vp.width * outputScale`.
  textLayer.style.width  = vp.width  + 'px';
  textLayer.style.height = vp.height + 'px';

  const textLayerTask = pdfjsLib.renderTextLayer({
    textContentSource: textContent,
    container: textLayer,
    viewport: vp,
    textDivs: [],
  });

  wrap.appendChild(canvas);
  wrap.appendChild(textLayer);
  container.appendChild(wrap);

  await textLayerTask.promise;
  return wrap;
}

// Reduces the requested dpr just enough that width*scale x height*scale
// stays under the cap, rather than clamping every page to some fixed lower
// dpr globally — an ordinary page at a sane zoom never triggers this at
// all, so it never loses sharpness it did not need to.
function clampToBackingStoreCap(cssWidth, cssHeight, dpr) {
  const area = cssWidth * dpr * (cssHeight * dpr);
  if (area <= MAX_BACKING_STORE_PX) return dpr;
  const scaleDown = Math.sqrt(MAX_BACKING_STORE_PX / (cssWidth * cssHeight));
  return Math.max(1, scaleDown); // never go below 1x — a blurry page is still better than one at less than its own CSS size
}

/* devicePixelRatio has no native 'change' event — the standard idiom is a
 * matchMedia query for the CURRENT ratio that fires once when it stops
 * matching (the ratio changed), at which point a fresh query for the NEW
 * ratio has to be armed or it would never fire again. Covers dragging the
 * window between a laptop panel and an external monitor at a different
 * scale factor. Returns a function that removes the current listener. */
export function watchDevicePixelRatio(onChange) {
  let mql;
  let stopped = false;
  function arm() {
    if (stopped) return;
    mql = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mql.addEventListener('change', handle, { once: true });
  }
  function handle() {
    if (stopped) return;
    onChange(window.devicePixelRatio);
    arm();
  }
  arm();
  return () => { stopped = true; try { mql?.removeEventListener('change', handle); } catch (e) {} };
}
