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
  it('ignores short or non-text input', () => {
    expect(hasArgumentCues('You should.')).toBe(false);
    expect(hasArgumentCues(null)).toBe(false);
  });
});
