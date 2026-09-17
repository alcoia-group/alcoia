/* receipt.js — a reader-owned record of a reading session
 *
 * Design rules from CLAUDE.md, none of them negotiable:
 *
 * - Generated only on explicit reader action. Nothing here runs on a timer and
 *   nothing is submitted anywhere in the background.
 * - The reader sees the full contents before they can share it.
 * - No raw gaze coordinates, ever. Aggregates only. `buildReceipt` takes
 *   already-aggregated numbers and there is no code path that reaches a
 *   coordinate buffer.
 * - No covert mode. Not behind a flag, not for an institution.
 *
 * The recall block is the substance. Coverage without recall says only that a
 * page was scrolled past, which anyone can fake in seconds; answers to
 * questions about the text cannot be faked without reading it.
 *
 * WHAT A SIGNATURE HERE DOES AND DOES NOT MEAN
 * The signature proves the receipt has not been altered since the server
 * issued it. It does NOT prove the numbers were honestly measured — the
 * client supplies them, and a modified client could supply anything. Any
 * wording shown to a lecturer must say "unaltered since issue", never
 * "verified" or "authentic". See buildReceipt's `caveat` field, which is part
 * of the artifact for exactly this reason.
 */

import { createShadowHost } from './shadow-host.js';

export const RECEIPT_VERSION = 1;

/* Non-reversible page identifier. The URL itself is not included: a receipt
 * shared with a lecturer should not disclose the reader's full browsing
 * target, and the hash is enough to confirm two receipts describe the same
 * page. FNV-1a — this is an identifier, not a security control. */
export function hashUrl(url) {
  const s = String(url || '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `u${h.toString(16)}${s.length.toString(16)}`;
}

function round(n, dp = 2) {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function pct(part, whole) {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return round(Math.min(100, (part / whole) * 100), 1);
}

/* Everything in `sources` is already aggregated by the module that owns it.
 * Nothing is read from a raw buffer here, deliberately — see the header. */
export function buildReceipt(sources = {}) {
  const {
    session = {},        // sessionTracker.snapshot()
    recall = {},         // responseSignals.stats()
    recallItems = [],    // responseSignals.history()
    reading = {},        // sessionRecall.stats()
    progression = {},    // progressionEntropy.stats()
    regressions = {},    // scrollRegression.stats()
    interaction = {},    // interactionSignals.stats()
    document: doc = {},  // { title, url, wordCount, paragraphs }
    now = Date.now(),
  } = sources;

  const paragraphsRead = Number(reading.paragraphsRead) || 0;
  const paragraphTotal = Number(doc.paragraphs) || 0;

  return {
    version: RECEIPT_VERSION,
    generatedAt: new Date(now).toISOString(),

    document: {
      urlHash: hashUrl(doc.url),
      title: String(doc.title || '').slice(0, 200),
      wordCount: Number(doc.wordCount) || 0,
      paragraphs: paragraphTotal,
    },

    session: {
      started: session.startedAt ? new Date(session.startedAt).toISOString() : null,
      durationMs: Number(session.durationMs) || 0,
      paragraphsReached: paragraphsRead,
      coveragePct: pct(paragraphsRead, paragraphTotal),
    },

    engagement: {
      progressionEntropy: round(progression.normalized, 3),
      sessionShape: progression.shape || 'unknown',
      meanDwellMs: Math.round(Number(progression.meanDwellMs) || 0),
      regressions: Number(regressions.regressions) || 0,
      blurEvents: Number(interaction.blurEvents) || 0,
      longBlurEvents: Number(interaction.longBlurEvents) || 0,
      paragraphsStruggledOn: Number(reading.struggled) || 0,
    },

    /* The part that means anything. */
    recall: {
      questionsAsked: Number(recall.asked) || 0,
      answered: Number(recall.answered) || 0,
      correct: Number(recall.correct) || 0,
      dismissed: Number(recall.dismissed) || 0,
      medianLatencyMs: Number.isFinite(recall.medianLatencyMs) ? recall.medianLatencyMs : null,
      items: recallItems
        .filter((i) => i && i.correct !== null)
        .map((i) => ({
          correct: !!i.correct,
          latencyMs: Number(i.latencyMs) || 0,
          revisions: Number(i.revisions) || 0,
          scrolledBack: !!i.scrolledBack,
          // The cited sentence, so a reader can see what was asked about.
          // Truncated: a receipt is a summary, not a copy of the article.
          span: String(i.span || '').slice(0, 180),
        })),
    },

    caveat: 'These figures are reported by the reader\'s own browser. A signature shows the receipt has not been altered since it was issued; it does not verify that the reading happened as described.',
  };
}

/* A receipt with no recall block is not evidence of anything. Callers should
 * warn rather than silently present coverage as if it meant something. */
export function receiptIsSubstantive(receipt) {
  return !!receipt && Number(receipt.recall?.answered) > 0;
}

/* Stable serialisation for signing. Key order must not depend on how the
 * object was built, or a re-serialised receipt will not verify. */
export function canonicalise(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalise(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/* Guard against a receipt carrying anything it should not. Returns a list of
 * problems; empty means clean. Called before the preview is shown, so a
 * regression upstream surfaces to the reader rather than silently shipping. */
export function auditReceipt(receipt) {
  const problems = [];
  const banned = ['gaze', 'coordinate', 'coords', 'x', 'y', 'points', 'samples', 'frame', 'image'];

  const walk = (node, path) => {
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (banned.includes(k.toLowerCase())) problems.push(`${path}.${k} looks like raw sensor data`);
        walk(v, `${path}.${k}`);
      }
      return;
    }
    if (typeof node === 'string' && /^https?:\/\//i.test(node)) {
      problems.push(`${path} contains a full URL`);
    }
  };

  walk(receipt, 'receipt');
  return problems;
}


/* ── Preview and export ──────────────────────────────────────────────────────
 *
 * The reader sees the entire contents before anything can leave the machine.
 * There is no "share" that skips this panel, and no code path that sends a
 * receipt anywhere the reader did not click to send it.
 */
const Z_RECEIPT = 2147483647;

export function createReceiptPanel(deps = {}) {
  const { esc, signReceipt, sharedStyles = '' } = deps;
  let panel = null;
  let panelHost = null;

  function close() {
    if (panelHost) { try { panelHost.remove(); } catch (e) {} panelHost = null; }
    panel = null;
  }

  function row(label, value) {
    return `<div class="sra-r-row"><span>${esc(label)}</span><strong>${esc(String(value))}</strong></div>`;
  }

  function show(receipt) {
    close();
    const problems = auditReceipt(receipt);
    const substantive = receiptIsSubstantive(receipt);
    const r = receipt.recall;

    panel = document.createElement('div');
    panel.className = 'sra-receipt-backdrop';
    panel.innerHTML = `
      <div class="sra-receipt" role="dialog" aria-label="Reading receipt">
        <button class="sra-r-close" title="Close">✕</button>
        <h2>Reading receipt</h2>
        <p class="sra-r-sub">${esc(receipt.document.title || 'Untitled page')}</p>

        ${problems.length ? `<div class="sra-r-warn"><strong>Not shown to anyone yet.</strong>
          This receipt contains fields it should not: ${esc(problems.join('; '))}.
          Please report this rather than sharing it.</div>` : ''}

        ${substantive ? '' : `<div class="sra-r-warn">
          <strong>This receipt shows coverage but no recall.</strong> You have not answered any
          questions this session, so it records only that pages were scrolled through — which is
          not evidence of reading. Answer a few questions first if you intend to share it.</div>`}

        <h3>Recall</h3>
        ${row('Questions answered', `${r.answered} of ${r.questionsAsked}`)}
        ${row('Correct', r.answered ? `${r.correct} of ${r.answered}` : '—')}
        ${row('Median time to answer', r.medianLatencyMs != null ? `${Math.round(r.medianLatencyMs / 1000)}s` : '—')}
        ${r.dismissed ? row('Skipped', r.dismissed) : ''}

        <h3>Session</h3>
        ${row('Time on page', `${Math.round(receipt.session.durationMs / 60000)} min`)}
        ${row('Paragraphs read', receipt.session.paragraphsReached)}
        ${row('Coverage', receipt.session.coveragePct != null ? `${receipt.session.coveragePct}%` : '—')}
        ${row('Session shape', receipt.engagement.sessionShape)}
        ${row('Times you went back', receipt.engagement.regressions)}

        <details class="sra-r-raw">
          <summary>Everything in this receipt (${esc(String(JSON.stringify(receipt).length))} bytes)</summary>
          <pre>${esc(JSON.stringify(receipt, null, 2))}</pre>
        </details>

        <p class="sra-r-caveat">${esc(receipt.caveat)}</p>

        <div class="sra-r-actions">
          <button class="sra-btn sra-btn-secondary sra-r-copy">Copy</button>
          <button class="sra-btn sra-btn-secondary sra-r-download">Download</button>
          ${signReceipt ? '<button class="sra-btn sra-btn-primary sra-r-sign">Sign it</button>' : ''}
        </div>
        <div class="sra-r-status"></div>
      </div>`;

    const { host, shadow } = createShadowHost(sharedStyles, Z_RECEIPT);
    panelHost = host;
    shadow.appendChild(panel);

    const status = panel.querySelector('.sra-r-status');
    let current = receipt;

    panel.querySelector('.sra-r-close').onclick = close;
    panel.addEventListener('click', (e) => { if (e.target === panel) close(); });

    panel.querySelector('.sra-r-copy').onclick = async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(current, null, 2));
        status.textContent = 'Copied to your clipboard.';
      } catch (e) { status.textContent = 'Could not copy. Use Download instead.'; }
    };

    panel.querySelector('.sra-r-download').onclick = () => {
      const blob = new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `reading-receipt-${current.document.urlHash}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      status.textContent = 'Saved to your downloads.';
    };

    const signBtn = panel.querySelector('.sra-r-sign');
    if (signBtn) {
      signBtn.onclick = async () => {
        signBtn.disabled = true;
        status.textContent = 'Signing…';
        const signed = await signReceipt(current);
        if (!signed) {
          status.textContent = 'Signing unavailable. The receipt is still valid to share unsigned.';
          signBtn.disabled = false;
          return;
        }
        current = signed;
        const raw = panel.querySelector('.sra-r-raw pre');
        if (raw) raw.textContent = JSON.stringify(current, null, 2);
        status.textContent = 'Signed. A signature shows this file has not been edited since it was issued. It is not proof the reading happened.';
      };
    }

    return panel;
  }

  return { show, close };
}
