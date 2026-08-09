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
    rules: {
      'no-undef': 'error',
      // WARN, not error: 115 of these already exist across files nobody touched today, and a
      // config that fails on day one gets deleted. no-undef is the one that shipped a bug.
      'no-unused-vars': ['warn', {
        args: 'none',
        // `catch { }` with no binding is the codebase's own idiom for a deliberate swallow.
        caughtErrors: 'none',
        // JSX components and React itself read as unused to the base rule.
        varsIgnorePattern: '^[A-Z_]',
      }],
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
