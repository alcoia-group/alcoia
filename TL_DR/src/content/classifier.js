// // classifier.js — Auto-generated decision tree classifier
// // Trained on 1400 gaze samples, 9 features
// // Test accuracy: 0.909
// // Classes: focused, skimming, confused, zoning_out, overloaded
// //
// // Input: feature object with keys: avg_fixation_ms, fixation_std, regression_rate, saccade_length, saccade_std, gaze_drift_px, scroll_delta_px, velocity_mean, line_reread_count
// // Output: { label: string, confidence: float }

// // Feature key reference (what each field means):
// // avg_fixation_ms   — mean fixation duration in ms over last 2-3 seconds
// // fixation_std      — standard deviation of fixation durations (stability)
// // regression_rate   — fraction of saccades moving right→left (re-reading signal)
// // saccade_length    — mean pixel distance between consecutive fixations
// // saccade_std       — SD of saccade lengths (jumpiness)
// // gaze_drift_px     — mean vertical displacement from the estimated text baseline
// // scroll_delta_px   — total scroll distance in the window (0 = reader is stuck)
// // velocity_mean     — mean gaze speed in px/sec
// // line_reread_count — number of times gaze returned to a line it already passed

// // classifier.js - Decision Tree
// // Trained 1600 samples | Test acc: 0.915 | Webcam-optimised thresholds

// // classifier.js — Decision Tree (webcam-optimised v2)
// // Trained on 2000 samples | Test accuracy: 0.884
// // Key design: scroll_delta_px is the primary reliable signal for webcam gaze
// // line_reread_count and avg_fixation_ms distinguish confused/overloaded

// export function classifyGazeState(f) {
//   // f must have all 9 keys from FEATURES list
//   // Returns: { label: string, confidence: float 0–1 }
//   if (f.scroll_delta_px <= 17.1792) {
//     if (f.line_reread_count <= 1.3677) {
//       if (f.avg_fixation_ms <= 397.4409) {
//         if (f.saccade_length <= 77.3373) {
//           if (f.regression_rate <= 0.1735) {
//             return { label: 'confused', confidence: 0.625 };
//           } else {
//             return { label: 'confused', confidence: 1.000 };
//           }
//         } else {
//           if (f.saccade_length <= 96.8416) {
//             return { label: 'focused', confidence: 0.875 };
//           } else {
//             return { label: 'focused', confidence: 1.000 };
//           }
//         }
//       } else {
//         if (f.saccade_std <= 28.7368) {
//           if (f.avg_fixation_ms <= 628.0574) {
//             return { label: 'confused', confidence: 0.900 };
//           } else {
//             return { label: 'zoning_out', confidence: 1.000 };
//           }
//         } else {
//           if (f.saccade_std <= 36.8686) {
//             return { label: 'zoning_out', confidence: 0.900 };
//           } else {
//             return { label: 'zoning_out', confidence: 1.000 };
//           }
//         }
//       }
//     } else {
//       if (f.regression_rate <= 0.3320) {
//         if (f.line_reread_count <= 4.5708) {
//           if (f.avg_fixation_ms <= 580.6632) {
//             if (f.saccade_std <= 15.3448) {
//               if (f.saccade_length <= 59.5602) {
//                 return { label: 'overloaded', confidence: 0.548 };
//               } else {
//                 return { label: 'confused', confidence: 0.929 };
//               }
//             } else {
//               if (f.line_reread_count <= 1.6290) {
//                 return { label: 'confused', confidence: 0.640 };
//               } else {
//                 return { label: 'confused', confidence: 0.863 };
//               }
//             }
//           } else {
//             if (f.saccade_std <= 23.8744) {
//               return { label: 'overloaded', confidence: 0.800 };
//             } else {
//               return { label: 'zoning_out', confidence: 0.471 };
//             }
//           }
//         } else {
//           if (f.velocity_mean <= 187.0711) {
//             if (f.scroll_delta_px <= 3.5560) {
//               if (f.saccade_length <= 48.2463) {
//                 return { label: 'overloaded', confidence: 1.000 };
//               } else {
//                 return { label: 'overloaded', confidence: 0.875 };
//               }
//             } else {
//               return { label: 'overloaded', confidence: 0.774 };
//             }
//           } else {
//             return { label: 'confused', confidence: 0.562 };
//           }
//         }
//       } else {
//         if (f.saccade_length <= 65.2430) {
//           if (f.saccade_std <= 26.1318) {
//             if (f.line_reread_count <= 2.7248) {
//               if (f.line_reread_count <= 2.1907) {
//                 return { label: 'overloaded', confidence: 0.912 };
//               } else {
//                 return { label: 'overloaded', confidence: 0.562 };
//               }
//             } else {
//               if (f.scroll_delta_px <= 6.3407) {
//                 return { label: 'overloaded', confidence: 0.993 };
//               } else {
//                 return { label: 'overloaded', confidence: 0.914 };
//               }
//             }
//           } else {
//             return { label: 'overloaded', confidence: 0.607 };
//           }
//         } else {
//           return { label: 'confused', confidence: 0.700 };
//         }
//       }
//     }
//   } else {
//     if (f.avg_fixation_ms <= 150.3425) {
//       if (f.line_reread_count <= 0.7174) {
//         if (f.saccade_length <= 84.8909) {
//           return { label: 'focused', confidence: 1.000 };
//         } else {
//           if (f.regression_rate <= 0.1228) {
//             if (f.saccade_std <= 32.1741) {
//               return { label: 'skimming', confidence: 0.833 };
//             } else {
//               if (f.avg_fixation_ms <= 141.5124) {
//                 return { label: 'skimming', confidence: 1.000 };
//               } else {
//                 return { label: 'skimming', confidence: 0.938 };
//               }
//             }
//           } else {
//             return { label: 'skimming', confidence: 0.600 };
//           }
//         }
//       } else {
//         if (f.avg_fixation_ms <= 111.5046) {
//           return { label: 'focused', confidence: 0.938 };
//         } else {
//           return { label: 'focused', confidence: 1.000 };
//         }
//       }
//     } else {
//       if (f.saccade_length <= 148.3777) {
//         if (f.scroll_delta_px <= 20.1519) {
//           return { label: 'focused', confidence: 0.562 };
//         } else {
//           if (f.gaze_drift_px <= 33.6795) {
//             return { label: 'focused', confidence: 1.000 };
//           } else {
//             return { label: 'focused', confidence: 0.938 };
//           }
//         }
//       } else {
//         return { label: 'focused', confidence: 0.500 };
//       }
//     }
//   }
//   return { label: 'focused', confidence: 0.5 };
// }

// // Action mapping — what content.js does for each state
// export const COGNITIVE_STATE_ACTIONS = {
//   focused:    'none',      // reading fine — stay silent
//   skimming:   'none',      // deliberate fast scan — stay silent
//   confused:   'explain',   // fetch AI explanation of current paragraph
//   zoning_out: 'nudge',     // pulse-highlight paragraph, no AI call
//   overloaded: 'simplify',  // fetch AI simplification of current paragraph
// };

// export const STATE_LABELS = {
//   focused:    'Focused',
//   skimming:   'Skimming',
//   confused:   'Confused',
//   zoning_out: 'Zoning Out',
//   overloaded: 'Overloaded',
// };

// classifier.js - Decision Tree for TL;DR
// Auto-generated — do not edit by hand
// Webcam-noise-robust retraining | Samples: 4000 train | Test accuracy: 0.851
// Noise augmentation: clean + perturbed copies | Scroll capped at 25px
// Leaves: 57 | Root split: scroll_delta_px <= 16.6988

export function classifyGazeState(f) {
  if (f.scroll_delta_px <= 16.6988) {
    if (f.line_reread_count <= 1.7894) {
      if (f.avg_fixation_ms <= 450.6244) {
        if (f.regression_rate <= 0.2163) {
          if (f.velocity_mean <= 185.0838) {
            return { label: 'focused', confidence: 0.556 };
          } else {
            return { label: 'focused', confidence: 1.000 };
          }
        } else {
          if (f.saccade_length <= 48.0152) {
            return { label: 'confused', confidence: 0.962 };
          } else {
            return { label: 'confused', confidence: 0.636 };
          }
        }
      } else {
        if (f.saccade_std <= 14.7128) {
          if (f.avg_fixation_ms <= 646.0558) {
            return { label: 'confused', confidence: 0.800 };
          } else {
            return { label: 'zoning_out', confidence: 0.632 };
          }
        } else {
          if (f.saccade_std <= 36.0569) {
            if (f.gaze_drift_px <= 37.6753) {
              if (f.avg_fixation_ms <= 778.8824) {
                return { label: 'confused', confidence: 0.778 };
              } else {
                return { label: 'zoning_out', confidence: 1.000 };
              }
            } else {
              return { label: 'zoning_out', confidence: 1.000 };
            }
          } else {
            if (f.gaze_drift_px <= 15.3839) {
              return { label: 'zoning_out', confidence: 0.944 };
            } else {
              return { label: 'zoning_out', confidence: 1.000 };
            }
          }
        }
      }
    } else {
      if (f.scroll_delta_px <= 7.3524) {
        if (f.regression_rate <= 0.3737) {
          if (f.avg_fixation_ms <= 844.0301) {
            if (f.line_reread_count <= 5.6911) {
              if (f.avg_fixation_ms <= 674.8620) {
                if (f.gaze_drift_px <= 29.5750) {
                  return { label: 'confused', confidence: 0.602 };
                } else {
                  return { label: 'confused', confidence: 0.854 };
                }
              } else {
                if (f.saccade_length <= 37.9284) {
                  return { label: 'overloaded', confidence: 0.833 };
                } else {
                  return { label: 'confused', confidence: 0.500 };
                }
              }
            } else {
              if (f.saccade_length <= 38.9983) {
                if (f.regression_rate <= 0.2648) {
                  return { label: 'overloaded', confidence: 0.667 };
                } else {
                  return { label: 'overloaded', confidence: 0.957 };
                }
              } else {
                if (f.fixation_std <= 167.9492) {
                  return { label: 'confused', confidence: 0.583 };
                } else {
                  return { label: 'overloaded', confidence: 0.842 };
                }
              }
            }
          } else {
            if (f.avg_fixation_ms <= 1090.1516) {
              return { label: 'zoning_out', confidence: 0.667 };
            } else {
              return { label: 'zoning_out', confidence: 1.000 };
            }
          }
        } else {
          if (f.line_reread_count <= 5.5910) {
            if (f.gaze_drift_px <= 22.2109) {
              if (f.regression_rate <= 0.4779) {
                if (f.fixation_std <= 166.5330) {
                  return { label: 'overloaded', confidence: 0.588 };
                } else {
                  return { label: 'overloaded', confidence: 0.906 };
                }
              } else {
                if (f.saccade_length <= 59.1363) {
                  return { label: 'overloaded', confidence: 0.956 };
                } else {
                  return { label: 'overloaded', confidence: 0.667 };
                }
              }
            } else {
              if (f.velocity_mean <= 187.1903) {
                if (f.gaze_drift_px <= 40.9787) {
                  return { label: 'overloaded', confidence: 0.650 };
                } else {
                  return { label: 'confused', confidence: 0.789 };
                }
              } else {
                return { label: 'confused', confidence: 0.781 };
              }
            }
          } else {
            if (f.saccade_std <= 22.3780) {
              if (f.velocity_mean <= 45.9580) {
                return { label: 'overloaded', confidence: 0.889 };
              } else {
                if (f.velocity_mean <= 186.7220) {
                  return { label: 'overloaded', confidence: 1.000 };
                } else {
                  return { label: 'overloaded', confidence: 0.957 };
                }
              }
            } else {
              return { label: 'overloaded', confidence: 0.818 };
            }
          }
        }
      } else {
        if (f.avg_fixation_ms <= 600.2897) {
          if (f.fixation_std <= 212.1005) {
            if (f.velocity_mean <= 274.9861) {
              if (f.regression_rate <= 0.4422) {
                if (f.fixation_std <= 161.0720) {
                  return { label: 'confused', confidence: 0.987 };
                } else {
                  return { label: 'confused', confidence: 0.897 };
                }
              } else {
                if (f.scroll_delta_px <= 9.8606) {
                  return { label: 'confused', confidence: 0.560 };
                } else {
                  return { label: 'confused', confidence: 0.957 };
                }
              }
            } else {
              return { label: 'confused', confidence: 0.611 };
            }
          } else {
            return { label: 'confused', confidence: 0.500 };
          }
        } else {
          if (f.scroll_delta_px <= 9.8166) {
            if (f.regression_rate <= 0.3395) {
              return { label: 'confused', confidence: 0.500 };
            } else {
              return { label: 'overloaded', confidence: 0.833 };
            }
          } else {
            if (f.gaze_drift_px <= 21.0091) {
              return { label: 'confused', confidence: 0.556 };
            } else {
              return { label: 'confused', confidence: 0.947 };
            }
          }
        }
      }
    }
  } else {
    if (f.saccade_length <= 149.0458) {
      if (f.saccade_std <= 53.8375) {
        if (f.regression_rate <= 0.3117) {
          if (f.velocity_mean <= 526.8494) {
            if (f.avg_fixation_ms <= 418.1136) {
              if (f.velocity_mean <= 468.6265) {
                if (f.saccade_std <= 46.7535) {
                  return { label: 'focused', confidence: 0.993 };
                } else {
                  return { label: 'focused', confidence: 0.919 };
                }
              } else {
                return { label: 'focused', confidence: 0.769 };
              }
            } else {
              return { label: 'focused', confidence: 0.667 };
            }
          } else {
            return { label: 'skimming', confidence: 0.875 };
          }
        } else {
          return { label: 'confused', confidence: 0.867 };
        }
      } else {
        if (f.saccade_length <= 84.6289) {
          return { label: 'focused', confidence: 0.667 };
        } else {
          if (f.velocity_mean <= 399.8137) {
            return { label: 'skimming', confidence: 0.724 };
          } else {
            return { label: 'skimming', confidence: 1.000 };
          }
        }
      }
    } else {
      if (f.saccade_std <= 24.0925) {
        return { label: 'focused', confidence: 0.500 };
      } else {
        if (f.regression_rate <= 0.1779) {
          if (f.avg_fixation_ms <= 244.9123) {
            if (f.saccade_length <= 175.0086) {
              if (f.regression_rate <= 0.0942) {
                return { label: 'skimming', confidence: 1.000 };
              } else {
                return { label: 'skimming', confidence: 0.778 };
              }
            } else {
              return { label: 'skimming', confidence: 1.000 };
            }
          } else {
            return { label: 'skimming', confidence: 0.808 };
          }
        } else {
          return { label: 'skimming', confidence: 0.722 };
        }
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

export const STATE_LABELS = {
  focused:    'Focused',
  skimming:   'Skimming',
  confused:   'Confused',
  zoning_out: 'Zoning Out',
  overloaded: 'Overloaded',
}; 