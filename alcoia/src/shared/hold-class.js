/* hold-class.js — turns the policy's reason for NOT interrupting into one word from a closed list, so the product can be
 * measured ("how often is a card held back, and by what") without keeping any reading content. The reason strings are the
 * policy's own fixed sentences; a reason that is not recognised, or that is routine (no state, on pace, low confidence),
 * has no class and is not counted at all. */
export const HOLD_CLASSES = Object.freeze(['budget', 'cooldown', 'dismissed_before', 'already_asked', 'card_open', 'learner_evidence', 'turned_away']);

export function holdClassOf(reason) {
  const r = String(reason ?? '');
  if (/session budget/i.test(r) || /keeping the last slot/i.test(r)) return 'budget';
  if (/since the last interruption/i.test(r)) return 'cooldown';
  if (/consecutive dismissals|declined \d+ questions/i.test(r)) return 'dismissed_before';
  if (/already interrupted on this paragraph/i.test(r)) return 'already_asked';
  if (/question card is already visible/i.test(r)) return 'card_open';
  if (/learner estimate/i.test(r) || /recent correct answer/i.test(r)) return 'learner_evidence';
  if (/turns \w+ cards away/i.test(r)) return 'turned_away';
  return null;
}
