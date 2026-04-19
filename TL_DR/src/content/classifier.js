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

export function classifyGazeState(f) {
  if (f.scroll_delta_px <= 16.1272) {
    if (f.line_reread_count <= 0.9984) {
      if (f.avg_fixation_ms <= 411.3088) {
        return { label: 'focused', confidence: 1.000 };
      } else {
        return { label: 'zoning_out', confidence: 1.000 };
      }
    } else {
      if (f.line_reread_count <= 4.4636) {
        if (f.avg_fixation_ms <= 806.1335) {
          if (f.saccade_length <= 50.8934) {
            if (f.scroll_delta_px <= 5.6578) {
              if (f.line_reread_count <= 1.9895) {
                return { label: 'confused', confidence: 0.950 };
              } else {
                return { label: 'overloaded', confidence: 0.708 };
              }
            } else {
              if (f.line_reread_count <= 3.2848) {
                return { label: 'confused', confidence: 0.932 };
              } else {
                return { label: 'confused', confidence: 0.720 };
              }
            }
          } else {
            if (f.saccade_length <= 84.5508) {
              if (f.velocity_mean <= 125.6461) {
                return { label: 'confused', confidence: 0.800 };
              } else {
                return { label: 'confused', confidence: 0.973 };
              }
            } else {
              return { label: 'confused', confidence: 0.500 };
            }
          }
        } else {
          return { label: 'zoning_out', confidence: 1.000 };
        }
      } else {
        if (f.saccade_length <= 60.3914) {
          if (f.saccade_std <= 24.1571) {
            if (f.avg_fixation_ms <= 304.1107) {
              return { label: 'overloaded', confidence: 0.786 };
            } else {
              if (f.fixation_std <= 111.5951) {
                return { label: 'overloaded', confidence: 0.944 };
              } else {
                return { label: 'overloaded', confidence: 1.000 };
              }
            }
          } else {
            return { label: 'overloaded', confidence: 0.611 };
          }
        } else {
          return { label: 'confused', confidence: 0.571 };
        }
      }
    }
  } else {
    if (f.avg_fixation_ms <= 151.2495) {
      if (f.line_reread_count <= 0.7558) {
        if (f.saccade_length <= 130.3223) {
          return { label: 'skimming', confidence: 0.667 };
        } else {
          return { label: 'skimming', confidence: 1.000 };
        }
      } else {
        return { label: 'focused', confidence: 0.941 };
      }
    } else {
      if (f.velocity_mean <= 453.0251) {
        if (f.regression_rate <= 0.1991) {
          if (f.avg_fixation_ms <= 162.7423) {
            return { label: 'focused', confidence: 0.929 };
          } else {
            if (f.scroll_delta_px <= 20.7035) {
              return { label: 'focused', confidence: 0.929 };
            } else {
              return { label: 'focused', confidence: 1.000 };
            }
          }
        } else {
          return { label: 'confused', confidence: 0.647 };
        }
      } else {
        return { label: 'skimming', confidence: 0.857 };
      }
    }
  }
  return { label: 'focused', confidence: 0.5 };
}

export const COGNITIVE_STATE_ACTIONS = {
  focused:    'none',
  skimming:   'none',
  confused:   'explain',
  zoning_out: 'nudge',
  overloaded: 'simplify',
};