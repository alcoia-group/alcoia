import { describe, it, expect } from 'vitest';
import { hasArgumentCues } from '../alcoia/src/content/argument-cues.js';

describe('hasArgumentCues', () => {
  it('finds a paragraph that takes a side', () => {
    expect(hasArgumentCues('Governments should tax sugary drinks, because the evidence shows it lowers consumption over time.')).toBe(true);
    expect(hasArgumentCues('In my view, the court was wrong to read the statute so narrowly, and later cases confirm it.')).toBe(true);
  });
  it('ignores a plain description', () => {
    expect(hasArgumentCues('The mitochondrion is an organelle found in most cells. It produces energy for the cell to use.')).toBe(false);
  });
  it('ignores instructions and facts in reference text (cloud docs, anatomy, maths)', () => {
    expect(hasArgumentCues('You should enable encryption on every storage bucket, and access keys must be rotated every ninety days.')).toBe(false);
    expect(hasArgumentCues('The heart pumps blood through the body. The right side sends blood to the lungs, the left side to the rest of the body.')).toBe(false);
    expect(hasArgumentCues('The probability of two independent events both happening is the product of their probabilities. You need to check independence first.')).toBe(false);
  });
  it('ignores short or non-text input', () => {
    expect(hasArgumentCues('You should.')).toBe(false);
    expect(hasArgumentCues(null)).toBe(false);
  });
});
