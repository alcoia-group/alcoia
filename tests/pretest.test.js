// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { findOcclusionTarget, isOccludableParagraph, createPretestOcclusion } from '../alcoia/src/content/pretest.js';
import { createInterventionPolicy } from '../alcoia/src/content/intervention-policy.js';
import { STATES } from '../alcoia/src/content/state-engine.js';

describe('findOcclusionTarget — discourse-marker pattern matching (item: pretesting)', () => {
  it('fires on "the researchers discovered that..."', () => {
    const text = 'Scientists ran a long trial. The researchers discovered that sleep improves memory consolidation. The team published the findings a year later.';
    const r = findOcclusionTarget(text);
    expect(r).not.toBeNull();
    expect(r.hiddenText).toMatch(/team published/);
  });

  it('fires on "the result was..."', () => {
    const text = 'They changed one variable at a time. The result was a 40% increase in throughput. Nobody expected it to be that large.';
    const r = findOcclusionTarget(text);
    expect(r).not.toBeNull();
    expect(r.hiddenText).toMatch(/Nobody expected/);
  });

  it('fires on "what happened next..."', () => {
    const text = 'The committee reviewed the proposal for weeks. What happened next surprised everyone. The board approved it unanimously the following morning.';
    const r = findOcclusionTarget(text);
    expect(r).not.toBeNull();
    expect(r.hiddenText).toMatch(/board approved/);
  });

  it('is case-insensitive and matches close variants (results were / scientists found that)', () => {
    expect(findOcclusionTarget('Intro. The results were mixed. It took another year to explain why.')).not.toBeNull();
    expect(findOcclusionTarget('Intro. THE SCIENTISTS FOUND THAT the effect reversed at scale. Nobody had predicted it.')).not.toBeNull();
  });

  it('does not fire on ordinary prose with none of the trigger phrases', () => {
    expect(findOcclusionTarget('The cat sat on the mat. It was a warm afternoon. Nothing else happened.')).toBeNull();
  });

  it('abstains when the trigger is in the paragraph\'s last sentence — nothing follows to occlude', () => {
    expect(findOcclusionTarget('They ran the experiment for a year. The result was')).toBeNull();
  });

  it('abstains on empty or non-string input', () => {
    expect(findOcclusionTarget('')).toBeNull();
    expect(findOcclusionTarget(null)).toBeNull();
  });
});

function makeInterventionPolicy(overrides = {}) {
  return {
    evaluateContentTrigger: vi.fn(() => ({ allow: true, action: 'pretest', reason: 'ok', evidence: [], paragraphKey: 'k' })),
    record: vi.fn(),
    ...overrides,
  };
}

function setPlainParagraph(text) {
  document.body.innerHTML = '';
  const p = document.createElement('p');
  p.textContent = text;
  document.body.appendChild(p);
  return p;
}

describe('createPretestOcclusion — occlusion + reveal on a plain-paragraph fixture', () => {
  it('occludes the sentence after the trigger and inserts a predict/reveal prompt', () => {
    const p = setPlainParagraph('The researchers discovered that the effect was reversible. It took three more experiments to confirm it.');
    const policy = makeInterventionPolicy();
    const pretest = createPretestOcclusion({ interventionPolicy: policy, viewportHeight: () => 0 });

    const decision = pretest.scan();
    expect(decision).not.toBeNull();
    expect(decision.allow).toBe(true);
    expect(policy.record).toHaveBeenCalledWith(decision);

    const hidden = p.querySelector('.sra-pretest-hidden');
    expect(hidden).not.toBeNull();
    expect(hidden.textContent).toMatch(/three more experiments/);

    const prompt = p.querySelector('.sra-pretest-prompt');
    expect(prompt).not.toBeNull();
    expect(prompt.querySelector('.sra-pretest-reveal-btn')).not.toBeNull();
    expect(prompt.querySelector('.sra-pretest-guess')).not.toBeNull();
  });

  it('reveal shows the guess and the actual text side by side, and unhides the sentence', () => {
    const p = setPlainParagraph('The result was a 40% increase in output. Nobody expected it to be that large.');
    const pretest = createPretestOcclusion({ interventionPolicy: makeInterventionPolicy(), viewportHeight: () => 0 });
    pretest.scan();

    p.querySelector('.sra-pretest-guess').value = 'a small drop';
    p.querySelector('.sra-pretest-reveal-btn').click();

    expect(p.querySelector('.sra-pretest-hidden')).toBeNull();
    expect(p.querySelector('.sra-pretest-revealed')).not.toBeNull();
    const feedback = p.querySelector('.sra-pretest-feedback');
    expect(feedback.textContent).toContain('Your guess: "a small drop"');
    expect(feedback.textContent).toContain('What it actually says: "Nobody expected it to be that large."');
  });

  it('reveal without a typed guess just removes the prompt — no fabricated comparison or verdict', () => {
    const p = setPlainParagraph('The result was a 40% increase in output. Nobody expected it to be that large.');
    const pretest = createPretestOcclusion({ interventionPolicy: makeInterventionPolicy(), viewportHeight: () => 0 });
    pretest.scan();
    p.querySelector('.sra-pretest-reveal-btn').click();
    expect(p.querySelector('.sra-pretest-prompt')).toBeNull();
    expect(p.querySelector('.sra-pretest-feedback')).toBeNull();
    expect(p.querySelector('.sra-pretest-hidden')).toBeNull();
    expect(p.querySelector('.sra-pretest-revealed')).not.toBeNull();
  });

  it('never fires more than once per page, however many trigger phrases exist — the "rare" constraint', () => {
    document.body.innerHTML = '';
    const p1 = document.createElement('p'); p1.textContent = 'The result was a big jump. It changed everything that followed.';
    const p2 = document.createElement('p'); p2.textContent = 'What happened next was unexpected. Nobody had planned for it at all.';
    document.body.append(p1, p2);
    const policy = makeInterventionPolicy();
    const pretest = createPretestOcclusion({ interventionPolicy: policy, viewportHeight: () => 0 });
    expect(pretest.scan()).not.toBeNull();
    expect(pretest.scan()).toBeNull();
    expect(policy.record).toHaveBeenCalledTimes(1);
  });

  it('reset() allows a fresh occlusion after a route change', () => {
    setPlainParagraph('The result was a big jump. It changed everything that followed.');
    const policy = makeInterventionPolicy();
    const pretest = createPretestOcclusion({ interventionPolicy: policy, viewportHeight: () => 0 });
    pretest.scan();
    pretest.reset();
    setPlainParagraph('The result was a different jump. It changed a second thing that followed.');
    expect(pretest.scan()).not.toBeNull();
    expect(policy.record).toHaveBeenCalledTimes(2);
  });
});

describe('createPretestOcclusion — page shapes it does not attempt (reported, not silently guessed)', () => {
  it('never occludes a paragraph with nested markup — isOccludableParagraph says no', () => {
    document.body.innerHTML = '';
    const p = document.createElement('p');
    p.innerHTML = 'The result was <a href="#">a big jump</a>. It changed everything that followed.';
    document.body.appendChild(p);
    expect(isOccludableParagraph(p)).toBe(false);

    const policy = makeInterventionPolicy();
    const pretest = createPretestOcclusion({ interventionPolicy: policy, viewportHeight: () => 0 });
    expect(pretest.scan()).toBeNull();
    expect(policy.record).not.toHaveBeenCalled();
  });

  it('never occludes a paragraph already above the current viewport — already had the chance to be read', () => {
    setPlainParagraph('The result was a big jump. It changed everything that followed.');
    // jsdom has no layout engine — getBoundingClientRect() is all-zero by
    // default, so top: 0. A viewport height above that reads as "already
    // visible" the same way a real, already-scrolled-past paragraph would.
    const policy = makeInterventionPolicy();
    const pretest = createPretestOcclusion({ interventionPolicy: policy, viewportHeight: () => 800 });
    expect(pretest.scan()).toBeNull();
    expect(policy.record).not.toHaveBeenCalled();
  });
});

describe('createPretestOcclusion — respects the interruption budget (real intervention-policy.js)', () => {
  it('never renders once the session budget is spent', () => {
    const p = setPlainParagraph('The result was a big jump. It changed everything that followed.');
    const policy = createInterventionPolicy({ budget: { baseAllowance: 0, absoluteCeiling: 0 } });
    const pretest = createPretestOcclusion({ interventionPolicy: policy, viewportHeight: () => 0 });
    expect(pretest.scan()).toBeNull();
    expect(p.querySelector('.sra-pretest-hidden')).toBeNull();
  });

  it('spends the SAME counters a state-driven interruption would', () => {
    setPlainParagraph('The result was a big jump. It changed everything that followed.');
    const policy = createInterventionPolicy();
    const before = policy.stats();
    const pretest = createPretestOcclusion({ interventionPolicy: policy, viewportHeight: () => 0 });
    pretest.scan();
    const after = policy.stats();
    expect(after.count).toBe(before.count + 1);
    expect(after.remaining).toBe(before.remaining - 1);
  });

  it('never fires twice on the same paragraph — shares seenParagraphs with evaluate(), not a second budget', () => {
    const text = 'The result was a big jump. It changed everything that followed.';
    setPlainParagraph(text);
    // minGapMs: 0 isolates the paragraph-dedup check from the (separately
    // tested) minimum-gap check — both real rules would otherwise fire on
    // the same tick and the gap check would mask the one this test is about.
    const policy = createInterventionPolicy({ budget: { minGapMs: 0 } });
    const pretest = createPretestOcclusion({ interventionPolicy: policy, viewportHeight: () => 0 });
    pretest.scan();

    // The exact same paragraph text, evaluated the ordinary state-driven
    // way, is refused too — proof the two paths share one paragraph-dedup
    // set, not two independent "one interruption per paragraph" pools.
    const decision = policy.evaluate(
      { label: STATES.STRUGGLING, confidence: 0.9, evidence: [] },
      { currentEl: { innerText: text } },
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('already interrupted on this paragraph');
  });

  it('a state-driven interruption already recorded blocks a pretest trigger on a NEW paragraph via the shared minimum gap', () => {
    const policy = createInterventionPolicy();
    policy.record(policy.evaluate(
      { label: STATES.STRUGGLING, confidence: 0.9, evidence: [] },
      { currentEl: { innerText: 'An unrelated earlier paragraph that was already interrupted on.' } },
    ));

    setPlainParagraph('The result was a big jump. It changed everything that followed.');
    const pretest = createPretestOcclusion({ interventionPolicy: policy, viewportHeight: () => 0 });
    expect(pretest.scan()).toBeNull();
  });
});
