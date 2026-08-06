import globals from 'globals';

/* Deliberately not a style linter. The rules enabled here are the ones that
 * catch real defects in this codebase: undeclared identifiers (content.js is a
 * 1700-line IIFE where a typo silently creates a global), unused bindings left
 * behind by refactors, and the loose-equality and fallthrough patterns that
 * hide bugs. Formatting is left alone — there is no formatter in the repo and
 * adding one would bury real findings under a reformat diff. */

const browserExtension = {
  ...globals.browser,
  chrome: 'readonly',
};

export default [
  {
    ignores: [
      'node_modules/**',
      'TL_DR/src/libs/**',          // third-party, minified, not ours to lint
      'tldr classifier/**',
      'TL_DR/src/content/classifier.js',  // generated — regenerate, do not edit
    ],
  },

  // Extension code: browser globals, ES modules.
  {
    files: ['TL_DR/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: browserExtension,
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', {
        args: 'none',
        caughtErrors: 'none',            // `catch (e) {}` is used deliberately throughout
        varsIgnorePattern: '^_',
      }],
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-fallthrough': 'error',
      'no-cond-assign': 'error',
      'no-self-compare': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'use-isnan': 'error',
      'valid-typeof': 'error',
      eqeqeq: ['warn', 'smart'],
      'no-var': 'warn',
    },
  },

  // The service worker has no DOM. `webgazer` is declared because background.js
  // builds functions that chrome.scripting.executeScript serialises into the
  // page's MAIN world, where that global does exist — the reference is not a
  // service-worker reference at all.
  {
    files: ['TL_DR/background.js'],
    languageOptions: {
      globals: { ...globals.serviceworker, chrome: 'readonly', webgazer: 'readonly' },
    },
  },

  // The page-world bootstrap runs as a classic script, not a module.
  {
    files: ['TL_DR/src/content/webgazer-bootstrap.js', 'TL_DR/src/content/sra-page-bridge.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...browserExtension, webgazer: 'readonly' },
    },
  },

  // Server is Node.
  {
    files: ['TL_DR/server/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: globals.node,
    },
  },

  // Tests and tooling are Node + Vitest.
  {
    files: ['tests/**/*.js', 'tests/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      sourceType: 'module',
      // `chrome` appears inside page.evaluate() callbacks, which Playwright
      // serialises into the browser, not into Node.
      globals: { ...globals.node, ...globals.browser, chrome: 'readonly' },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
    },
  },
];
