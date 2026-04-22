// classifier.js — Auto-generated decision tree classifier
// Trained on 1400 gaze samples, 9 features
// Test accuracy: 0.909
// Classes: focused, skimming, confused, zoning_out, overloaded
//
// Input: feature object with keys: avg_fixation_ms, fixation_std, regression_rate, saccade_length, saccade_std, gaze_drift_px, scroll_delta_px, velocity_mean, line_reread_count
// Output: { label: string, confidence: float }

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

// classifier.js - Decision Tree
// Trained 1600 samples | Test acc: 0.915 | Webcam-optimised thresholds

// classifier.js — Decision Tree (webcam-optimised v2)
// Trained on 2000 samples | Test accuracy: 0.884
// Key design: scroll_delta_px is the primary reliable signal for webcam gaze
// line_reread_count and avg_fixation_ms distinguish confused/overloaded

export function classifyGazeState(f) {
  // f must have all 9 keys from FEATURES list
  // Returns: { label: string, confidence: float 0–1 }
  if (f.scroll_delta_px <= 17.1792) {
    if (f.line_reread_count <= 1.3677) {
      if (f.avg_fixation_ms <= 397.4409) {
        if (f.saccade_length <= 77.3373) {
          if (f.regression_rate <= 0.1735) {
            return { label: 'confused', confidence: 0.625 };
          } else {
            return { label: 'confused', confidence: 1.000 };
          }
        } else {
          if (f.saccade_length <= 96.8416) {
            return { label: 'focused', confidence: 0.875 };
          } else {
            return { label: 'focused', confidence: 1.000 };
          }
        }
      } else {
        if (f.saccade_std <= 28.7368) {
          if (f.avg_fixation_ms <= 628.0574) {
            return { label: 'confused', confidence: 0.900 };
          } else {
            return { label: 'zoning_out', confidence: 1.000 };
          }
        } else {
          if (f.saccade_std <= 36.8686) {
            return { label: 'zoning_out', confidence: 0.900 };
          } else {
            return { label: 'zoning_out', confidence: 1.000 };
          }
        }
      }
    } else {
      if (f.regression_rate <= 0.3320) {
        if (f.line_reread_count <= 4.5708) {
          if (f.avg_fixation_ms <= 580.6632) {
            if (f.saccade_std <= 15.3448) {
              if (f.saccade_length <= 59.5602) {
                return { label: 'overloaded', confidence: 0.548 };
              } else {
                return { label: 'confused', confidence: 0.929 };
              }
            } else {
              if (f.line_reread_count <= 1.6290) {
                return { label: 'confused', confidence: 0.640 };
              } else {
                return { label: 'confused', confidence: 0.863 };
              }
            }
          } else {
            if (f.saccade_std <= 23.8744) {
              return { label: 'overloaded', confidence: 0.800 };
            } else {
              return { label: 'zoning_out', confidence: 0.471 };
            }
          }
        } else {
          if (f.velocity_mean <= 187.0711) {
            if (f.scroll_delta_px <= 3.5560) {
              if (f.saccade_length <= 48.2463) {
                return { label: 'overloaded', confidence: 1.000 };
              } else {
                return { label: 'overloaded', confidence: 0.875 };
              }
            } else {
              return { label: 'overloaded', confidence: 0.774 };
            }
          } else {
            return { label: 'confused', confidence: 0.562 };
          }
        }
      } else {
        if (f.saccade_length <= 65.2430) {
          if (f.saccade_std <= 26.1318) {
            if (f.line_reread_count <= 2.7248) {
              if (f.line_reread_count <= 2.1907) {
                return { label: 'overloaded', confidence: 0.912 };
              } else {
                return { label: 'overloaded', confidence: 0.562 };
              }
            } else {
              if (f.scroll_delta_px <= 6.3407) {
                return { label: 'overloaded', confidence: 0.993 };
              } else {
                return { label: 'overloaded', confidence: 0.914 };
              }
            }
          } else {
            return { label: 'overloaded', confidence: 0.607 };
          }
        } else {
          return { label: 'confused', confidence: 0.700 };
        }
      }
    }
  } else {
    if (f.avg_fixation_ms <= 150.3425) {
      if (f.line_reread_count <= 0.7174) {
        if (f.saccade_length <= 84.8909) {
          return { label: 'focused', confidence: 1.000 };
        } else {
          if (f.regression_rate <= 0.1228) {
            if (f.saccade_std <= 32.1741) {
              return { label: 'skimming', confidence: 0.833 };
            } else {
              if (f.avg_fixation_ms <= 141.5124) {
                return { label: 'skimming', confidence: 1.000 };
              } else {
                return { label: 'skimming', confidence: 0.938 };
              }
            }
          } else {
            return { label: 'skimming', confidence: 0.600 };
          }
        }
      } else {
        if (f.avg_fixation_ms <= 111.5046) {
          return { label: 'focused', confidence: 0.938 };
        } else {
          return { label: 'focused', confidence: 1.000 };
        }
      }
    } else {
      if (f.saccade_length <= 148.3777) {
        if (f.scroll_delta_px <= 20.1519) {
          return { label: 'focused', confidence: 0.562 };
        } else {
          if (f.gaze_drift_px <= 33.6795) {
            return { label: 'focused', confidence: 1.000 };
          } else {
            return { label: 'focused', confidence: 0.938 };
          }
        }
      } else {
        return { label: 'focused', confidence: 0.500 };
      }
    }
  }
  return { label: 'focused', confidence: 0.5 };
}

// Action mapping — what content.js does for each state
export const COGNITIVE_STATE_ACTIONS = {
  focused:    'none',      // reading fine — stay silent
  skimming:   'none',      // deliberate fast scan — stay silent
  confused:   'explain',   // fetch AI explanation of current paragraph
  zoning_out: 'nudge',     // pulse-highlight paragraph, no AI call
  overloaded: 'simplify',  // fetch AI simplification of current paragraph
};

export const STATE_LABELS = {
  focused:    'Focused',
  skimming:   'Skimming',
  confused:   'Confused',
  zoning_out: 'Zoning Out',
  overloaded: 'Overloaded',
};