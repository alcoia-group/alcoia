// classifier.js — Auto-generated decision tree classifier
// Trained on 1400 gaze samples, 9 features
// Test accuracy: 0.909
// Classes: focused, skimming, confused, zoning_out, overloaded
//
// Input: feature object with keys: avg_fixation_ms, fixation_std, regression_rate, saccade_length, saccade_std, gaze_drift_px, scroll_delta_px, velocity_mean, line_reread_count
// Output: { label: string, confidence: float }

export function classifyGazeState(f) {
  // f = feature object, all numeric
  // Returns { label, confidence }
  if (f.scroll_delta_px <= 15.3766) {
    if (f.line_reread_count <= 1.4249) {
      if (f.velocity_mean <= 189.4888) {
        return { label: 'zoning_out', confidence: 1.000 };
      } else {
        return { label: 'focused', confidence: 0.750 };
      }
    } else {
      if (f.line_reread_count <= 4.8021) {
        if (f.scroll_delta_px <= 5.4282) {
          if (f.fixation_std <= 146.3801) {
            if (f.regression_rate <= 0.4701) {
              if (f.saccade_std <= 13.2391) {
                return { label: 'confused', confidence: 0.696 };
              } else {
                if (f.velocity_mean <= 127.0392) {
                  return { label: 'confused', confidence: 0.850 };
                } else {
                  return { label: 'confused', confidence: 1.000 };
                }
              }
            } else {
              if (f.avg_fixation_ms <= 506.0146) {
                return { label: 'confused', confidence: 0.688 };
              } else {
                return { label: 'overloaded', confidence: 0.800 };
              }
            }
          } else {
            if (f.velocity_mean <= 151.6927) {
              if (f.regression_rate <= 0.3664) {
                if (f.gaze_drift_px <= 21.1638) {
                  return { label: 'overloaded', confidence: 0.692 };
                } else {
                  return { label: 'confused', confidence: 0.667 };
                }
              } else {
                if (f.scroll_delta_px <= 0.1473) {
                  return { label: 'overloaded', confidence: 0.583 };
                } else {
                  return { label: 'overloaded', confidence: 0.976 };
                }
              }
            } else {
              if (f.gaze_drift_px <= 19.4216) {
                return { label: 'overloaded', confidence: 0.667 };
              } else {
                return { label: 'confused', confidence: 0.933 };
              }
            }
          }
        } else {
          if (f.fixation_std <= 190.7857) {
            if (f.avg_fixation_ms <= 374.5428) {
              return { label: 'confused', confidence: 0.857 };
            } else {
              return { label: 'confused', confidence: 1.000 };
            }
          } else {
            return { label: 'confused', confidence: 0.750 };
          }
        }
      } else {
        if (f.saccade_length <= 55.6993) {
          if (f.gaze_drift_px <= 27.5661) {
            if (f.velocity_mean <= 165.7430) {
              if (f.fixation_std <= 125.2399) {
                if (f.gaze_drift_px <= 19.7085) {
                  return { label: 'overloaded', confidence: 1.000 };
                } else {
                  return { label: 'overloaded', confidence: 0.750 };
                }
              } else {
                return { label: 'overloaded', confidence: 1.000 };
              }
            } else {
              return { label: 'overloaded', confidence: 0.647 };
            }
          } else {
            if (f.avg_fixation_ms <= 552.8671) {
              return { label: 'confused', confidence: 0.667 };
            } else {
              return { label: 'overloaded', confidence: 0.750 };
            }
          }
        } else {
          return { label: 'confused', confidence: 0.667 };
        }
      }
    }
  } else {
    if (f.avg_fixation_ms <= 158.2757) {
      if (f.line_reread_count <= 0.7024) {
        if (f.saccade_length <= 114.7416) {
          return { label: 'skimming', confidence: 0.750 };
        } else {
          return { label: 'skimming', confidence: 1.000 };
        }
      } else {
        return { label: 'focused', confidence: 0.846 };
      }
    } else {
      if (f.gaze_drift_px <= 25.2010) {
        if (f.saccade_length <= 55.2781) {
          return { label: 'focused', confidence: 0.667 };
        } else {
          if (f.avg_fixation_ms <= 167.9328) {
            return { label: 'focused', confidence: 0.917 };
          } else {
            return { label: 'focused', confidence: 1.000 };
          }
        }
      } else {
        return { label: 'skimming', confidence: 0.500 };
      }
    }
  }
  return { label: 'focused', confidence: 0.5 };
}

// Feature key reference (what each field means):
// avg_fixation_ms   — mean fixation duration in ms over last 2-3 seconds
// fixation_std      — standard deviation of fixation durations (stability)
// regression_rate   — fraction of saccades moving right→left (re-reading signal)
// saccade_length    — mean pixel distance between consecutive fixations
// saccade_std       — SD of saccade lengths (jumpiness)
// gaze_drift_px     — mean vertical displacement from the estimated text baseline
// scroll_delta_px   — total scroll distance in the window (0 = reader is stuck)
// velocity_mean     — mean gaze speed in px/sec
// line_reread_count — number of times gaze returned to a line it already passed

export const COGNITIVE_STATE_ACTIONS = {
  focused:    'none',          // user is reading fine — don't interrupt
  skimming:   'none',          // user is deliberately skimming
  confused:   'explain',       // trigger AI reverse-explanation popup
  zoning_out: 'nudge',         // gentle focus prompt (highlight current line)
  overloaded: 'simplify',      // break content into simpler chunks
};

export const STATE_LABELS = {
  focused:    'Focused',
  skimming:   'Skimming',
  confused:   'Confused',
  zoning_out: 'Zoning Out',
  overloaded: 'Overloaded',
};