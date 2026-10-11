import { describe, it, expect } from 'vitest';
import { hasRelationCues } from '../alcoia/src/content/relation-cues.js';

describe('hasRelationCues', () => {
  it('sees cause, dependence, contrast, comparison and part-of paragraphs', () => {
    expect(hasRelationCues('Prices rise because demand grows faster than supply, so sellers can charge more.')).toBe(true);
    expect(hasRelationCues('The output depends on the input; a larger input requires more time.')).toBe(true);
    expect(hasRelationCues('Bacteria reproduce quickly, whereas viruses need a host cell to copy themselves.')).toBe(true);
    expect(hasRelationCues('A cell membrane is part of the cell and controls what enters and leaves it.')).toBe(true);
  });
  it('does not fire on a plain list of facts, a short line, or non-text', () => {
    expect(hasRelationCues('The museum opens at nine and closes at five on weekdays in the summer months.')).toBe(false);
    expect(hasRelationCues('Because.')).toBe(false);
    expect(hasRelationCues(null)).toBe(false);
  });
});
