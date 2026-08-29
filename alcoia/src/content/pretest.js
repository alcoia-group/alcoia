/* pretest.js — predict-then-reveal: the pretesting effect, as an occlusion
 *
 * Richland, Kornell & Kao (2009): attempting an answer before reading it
 * improves later retention even when the guess is wrong, provided
 * corrective feedback follows. Pan & Sana found prequestions before video
 * also reduce mind wandering. The mechanic here is the client-side version
 * of that: hide the sentence a discourse marker signals is about to reveal
 * something, let the reader predict it, then show it next to their guess so
 * the comparison — not a grade — is the feedback.
 *
 * Deliberately narrow, per this feature's own convention: PATTERN MATCHING
 * on a fixed, literal list of discourse markers (mirrors text-difficulty.js's
 * SUBORDINATORS list), never inference about what a passage means. English
 * only — the trigger phrases are English strings, and there is no attempt
 * to generalise this to other languages.
 *
 * Scoped conservatively to what a Range can safely wrap: a paragraph-like
 * element (p/li/blockquote) whose ENTIRE content is a single plain text
 * node — no nested links, emphasis, code, images, or anything else. That is
 * the one shape `range.surroundContents()` can wrap without throwing or
 * silently mangling nested markup (CLAUDE.md's item 39 already documents
 * `surroundContents` as unsafe outside that shape, on pdf.js text layers).
 * A paragraph with any nested inline element, or a page rendered inside the
 * PDF/PPTX viewers, is simply never a candidate — not attempted, not a
 * broken fallback. See this file's own tests and the task report for the
 * explicit list of what remains unhandled.
 *
 * At most one occlusion per page (or SPA "page" — reset() on route change),
 * and only on a paragraph not yet scrolled into view — this is the
 * research's own "aggressive" framing kept in check. It spends from the
 * SAME interruption budget as every other intervention
 * (interventionPolicy.evaluateContentTrigger()/record(), see
 * intervention-policy.js) — never twice on one paragraph, the same session
 * cap, the same three-minute gap — because CLAUDE.md's "reader-initiated
 * actions spend no budget" is about actions the reader took; a page-content
 * -triggered prompt they did not ask for is not that.
 *
 * Standalone: this never touches state-engine.js or the substate work
 * (13a-13d). It is not a detection signal, and the discourse-marker match
 * is not fed into anything upstream.
 */

const TRIGGER_RE = new RegExp(
  '\\b(?:'
  + 'the researchers (?:discovered|found) that'
  + '|the scientists (?:discovered|found) that'
  + '|the study found that'
  + '|the team discovered that'
  + '|the results? (?:was|were|showed)'
  + '|the outcome was'
  + '|what happen(?:s|ed) next'
  + ')\\b',
  'i',
);

/* Terminal punctuation plus a trailing closing quote/paren, ASCII only —
 * this mechanic is English-only by design (see header), so segmentation.js's
 * full multi-script sentence splitter is not used here; it also loses
 * offsets by normalising whitespace first, and a DOM Range needs exact
 * offsets into the real text node. */
const SENTENCE_TERMINATOR_RE = /[.!?]+["'’”)\]]*/g;

function sentenceEndAfter(text, fromIndex) {
  SENTENCE_TERMINATOR_RE.lastIndex = fromIndex;
  const m = SENTENCE_TERMINATOR_RE.exec(text);
  return m ? m.index + m[0].length : -1;
}

/* Pure string logic, exported for direct testing without a DOM. Finds the
 * trigger phrase and the sentence AFTER the one it appears in — literally
 * "the following sentence" per the brief. For a trigger whose own payload
 * lands in its own sentence ("The result was a 40% increase.") rather than
 * the next one, this hides the sentence adjacent to the payload, not the
 * payload itself — a known, reported limitation of taking "following
 * sentence" literally rather than guessing per-pattern where the payload
 * actually sits. */
export function findOcclusionTarget(rawText) {
  if (typeof rawText !== 'string' || !rawText) return null;

  TRIGGER_RE.lastIndex = 0;
  const match = TRIGGER_RE.exec(rawText);
  if (!match) return null;

  const triggerEnd = match.index + match[0].length;
  const ownSentenceEnd = sentenceEndAfter(rawText, triggerEnd);
  if (ownSentenceEnd === -1) return null;   // the trigger's own sentence never closes — abstain

  let start = ownSentenceEnd;
  while (start < rawText.length && /\s/.test(rawText[start])) start++;
  if (start >= rawText.length) return null;  // nothing follows at all — abstain

  const nextEnd = sentenceEndAfter(rawText, start);
  const end = nextEnd === -1 ? rawText.length : nextEnd;
  if (end <= start) return null;

  return { trigger: match[0], triggerIndex: match.index, start, end, hiddenText: rawText.slice(start, end).trim() };
}

/* The one DOM shape this can safely occlude — see this file's own header. */
export function isOccludableParagraph(el) {
  return !!el && !!el.childNodes && el.childNodes.length === 1
    && !!el.firstChild && el.firstChild.nodeType === 3; // Node.TEXT_NODE
}

function isBelowViewport(el, viewportHeight) {
  let rect;
  try { rect = el.getBoundingClientRect(); } catch (e) { return false; }
  return rect.top >= viewportHeight();
}

function paragraphKeyFor(rawText) {
  return rawText.trim().slice(0, 80) || null;
}

export function createPretestOcclusion(deps = {}) {
  const doc              = deps.document || (typeof document !== 'undefined' ? document : null);
  const interventionPolicy = deps.interventionPolicy || null;
  const viewportHeight    = deps.viewportHeight || (() => window.innerHeight);
  const selector          = deps.selector || 'p, li, blockquote';

  let triggered = false;

  /* Renders the occlusion + predict/reveal UI in place. Returns the
   * decision on success so the caller can spend the budget, or null if the
   * DOM turned out not to be the safe shape after all (surroundContents
   * threw) — abstain rather than leave a half-built overlay. */
  function render(el, occlusion) {
    const range = doc.createRange();
    range.setStart(el.firstChild, occlusion.start);
    range.setEnd(el.firstChild, occlusion.end);

    const span = doc.createElement('span');
    span.className = 'sra-pretest-hidden';
    try {
      range.surroundContents(span);
    } catch (e) {
      return false;   // not the safe single-text-node case after all — abstain
    }

    const prompt = doc.createElement('span');
    prompt.className = 'sra-pretest-prompt';
    prompt.contentEditable = 'false';

    const label = doc.createElement('span');
    label.className = 'sra-pretest-label';
    label.textContent = 'Predict what comes next, then reveal';

    const input = doc.createElement('input');
    input.type = 'text';
    input.className = 'sra-pretest-guess';
    input.placeholder = 'your guess (optional)';
    input.maxLength = 200;

    const revealBtn = doc.createElement('button');
    revealBtn.type = 'button';
    revealBtn.className = 'sra-pretest-reveal-btn';
    revealBtn.textContent = 'Reveal';

    prompt.append(label, input, revealBtn);
    span.after(prompt);

    let revealed = false;
    revealBtn.onclick = () => {
      if (revealed) return;
      revealed = true;
      const guess = input.value.trim();
      span.classList.remove('sra-pretest-hidden');
      span.classList.add('sra-pretest-revealed');

      if (guess) {
        // Corrective feedback per the cited research: the reader's own
        // words next to what actually followed, so THEY see whether it
        // matched — never an automated verdict. A keyword-overlap check
        // would be a plausible-looking guess dressed up as a measurement
        // (invariant 5), and "matched" is exactly the kind of claim this
        // project does not make about itself.
        const feedback = doc.createElement('span');
        feedback.className = 'sra-pretest-feedback';
        const guessLine = doc.createElement('span');
        guessLine.className = 'sra-pretest-guess-echo';
        guessLine.textContent = `Your guess: "${guess}"`;
        const actualLine = doc.createElement('span');
        actualLine.className = 'sra-pretest-actual-echo';
        actualLine.textContent = `What it actually says: "${occlusion.hiddenText}"`;
        feedback.append(guessLine, actualLine);
        prompt.replaceWith(feedback);
      } else {
        prompt.remove();
      }
    };

    return true;
  }

  /* Scans the page once for the first straightforward, not-yet-visible
   * paragraph carrying a trigger phrase, and occludes it — at most one per
   * page. Call once per page load / SPA route (orchestrator.js's
   * primeParagraph()); not wired to the periodic idle tick or a mutation
   * observer, so content added after the initial scan (infinite scroll,
   * lazy-loaded sections) is not covered — a deliberate, reported scope
   * limit, not an oversight. */
  function scan() {
    if (triggered || !doc || !interventionPolicy) return null;

    for (const el of doc.querySelectorAll(selector)) {
      if (!isOccludableParagraph(el)) continue;
      if (!isBelowViewport(el, viewportHeight)) continue;

      const rawText = el.firstChild.nodeValue || '';
      const occlusion = findOcclusionTarget(rawText);
      if (!occlusion) continue;

      const decision = interventionPolicy.evaluateContentTrigger({
        paragraphKey: paragraphKeyFor(rawText),
        evidence: [`This passage says "${occlusion.trigger}" — something is about to be revealed`],
      });
      if (!decision.allow) continue;   // budget said no — try the next candidate, nothing was spent

      if (!render(el, occlusion)) continue;   // DOM turned out unsafe after all — nothing spent, try the next one

      interventionPolicy.record(decision);
      triggered = true;
      return decision;
    }
    return null;
  }

  return {
    scan,
    reset() { triggered = false; },
  };
}
