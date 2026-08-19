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
      'alcoia/src/libs/**',          // third-party, minified, not ours to lint
      'tldr classifier/**',
      'alcoia/src/content/classifier.js',  // generated — regenerate, do not edit
    ],
  },

  // Extension code: browser globals, ES modules.
  {
    files: ['alcoia/**/*.js'],
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
    files: ['alcoia/background.js'],
    languageOptions: {
      globals: { ...globals.serviceworker, chrome: 'readonly', webgazer: 'readonly' },
    },
  },

  // The local-file PDF/PPTX viewer pages (src/pdf-viewer, src/pptx-viewer) load
  // pdf.js/JSZip via an injected <script> tag rather than import — the same
  // reason background.js declares `webgazer` above: the identifier is real in
  // that page's global scope, just not one this linter can see from the file
  // alone. pptx-viewer's viewer.js is still a classic script (no import/export).
  // pdf-viewer's viewer.js became a real module in item 30c (it statically
  // imports reading-bridge.js), matching viewer.html's own `type="module"`.
  {
    files: ['alcoia/src/pdf-viewer/viewer.js', 'alcoia/src/pdf-viewer/render.js', 'alcoia/src/pdf-viewer/sidebar.js'],
    languageOptions: { sourceType: 'module', globals: { ...browserExtension, pdfjsLib: 'readonly' } },
  },
  {
    files: ['alcoia/src/pptx-viewer/viewer.js'],
    languageOptions: { sourceType: 'script', globals: { ...browserExtension, JSZip: 'readonly' } },
  },

  // Vendored CommonJS snapshots of the (now separate-repo) server's pure
  // modules — see tests/contract/*.js for why these exist here at all.
  {
    files: ['tests/contract/**/*.js'],
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
