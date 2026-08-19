/**
 * The client had NO lint config at all, and it cost a whole day.
 *
 * `poseView` was used 300 lines outside the block that declared it, so every generation threw
 * ReferenceError at the Library write, was caught, and surfaced as a toast people had learned to
 * ignore — the image rendered on screen and simply never reached the Library. Vite/esbuild does not
 * error on an undefined identifier; it only transpiles. A second one (`load()` for `refresh()` in
 * EddyCollection) was sitting in the same file set (audit, 2026-08-09).
 *
 * So this config is deliberately NARROW. It is not a style pass and it must never become one: a
 * hundred formatting complaints would be turned off within the week and take the two rules that
 * actually matter with them. It catches the bugs a human cannot see by reading:
 *
 *   no-undef            — the one that shipped
 *   no-unused-vars      — the shape a half-finished rename leaves behind (errors only; args and
 *                         intentionally-unused catch bindings are ignored)
 *   no-const-assign,
 *   no-dupe-keys,
 *   no-unreachable      — free, and each has bitten a codebase this size
 *
 * Run it:  npx eslint src --ext .js,.jsx
 */
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    // Vendored third-party code, linted by whoever wrote it. `src/lib/vendor/pico.js` uses an
    // implicit global in a minified helper; that is their bug to have, not ours to rewrite.
    ignores: ['src/lib/vendor/**'],
  },
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        // Preload-injected bridge from the Electron shell.
        electronAPI: 'readonly',
      },
    },
    linterOptions: {
      // OFF on purpose. The codebase uses `eslint-disable-next-line no-await-in-loop` as
      // DOCUMENTATION for deliberately sequential loops, and that rule is not enabled here. Flagging
      // those 22 comments as unused would invite deleting explanations of real decisions.
      reportUnusedDisableDirectives: false,
    },
    // The codebase carries `eslint-disable-next-line react-hooks/exhaustive-deps` in ~10 places.
    // eslint-plugin-react-hooks is not installed, and an unknown rule name in a disable comment is
    // itself an error — so the rule is registered here as a no-op. Those comments keep documenting
    // the intent, and adding the real plugin later is a one-line swap.
    plugins: {
      'react-hooks': { rules: { 'exhaustive-deps': { create: () => ({}) } } },
      // Same reason: one file carries a jsx-a11y disable and that plugin is not installed either.
      'jsx-a11y': { rules: { 'no-noninteractive-element-interactions': { create: () => ({}) } } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'no-undef': 'error',
      /**
       * no-use-before-define is the rule that would have caught the page-crash on 2026-08-09.
       *
       * A useMemo placed above the `const` it names in its DEPENDENCY ARRAY is a TDZ
       * ReferenceError at render — the whole page goes blank. no-undef cannot see it, because the
       * name IS defined, just later; the build cannot see it, because it is valid syntax. Twice in
       * one day: `poseView` read outside its block, and `viewBreakdown` reading `combos`.
       *
       * Functions are exempt (`functions: false`): hoisted declarations called from above are the
       * normal shape of this codebase and flagging them would bury the two cases that matter.
       */
      // WARN, not error. It flags 16 pre-existing cases that are harmless -- a const arrow
      // referenced by a handler that only runs after mount is fine, and failing on those would
      // get the whole config deleted. The case that actually crashes -- a hook dependency array
      // naming a const declared later, which is evaluated DURING render -- is caught precisely by
      // check_tdz_deps.js, which fails hard and has no false positives.
      'no-use-before-define': ['warn', { functions: false, classes: true, variables: true }],
      // WARN, not error: 115 of these already exist across files nobody touched today, and a
      // config that fails on day one gets deleted. no-undef is the one that shipped a bug.
      'no-unused-vars': ['warn', {
        args: 'none',
        // `catch { }` with no binding is the codebase's own idiom for a deliberate swallow.
        caughtErrors: 'none',
        // JSX components and React itself read as unused to the base rule.
        varsIgnorePattern: '^[A-Z_]',
      }],
      /**
       * MISSING HOOK DEPS — the bug class that produced three separate "the toggle does nothing"
       * reports on 2026-08-19.
       *
       * A useCallback that reads state absent from its dep array keeps a FROZEN copy of it. On
       * Photo Match that meant flipping "Look at camera" or "Outfit from: her photos" and paying
       * for a picture built from the previous setting, with the toggle sitting visibly on. It only
       * corrected itself when some unrelated listed dep changed, which is why it read as
       * intermittent instead of broken, and why nobody could reproduce it on demand.
       *
       * WARN, in the spirit of the note at the top of this file: the repo has pre-existing cases
       * that are deliberate, and a rule that fails the build on day one gets deleted along with
       * the two rules that actually matter. It is here to be READ during a change — and
       * check-hook-deps.js fails hard on the handful that are known to bite.
       */
      'react-hooks/exhaustive-deps': 'warn',
      'no-const-assign': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-self-assign': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
    },
  },
];
