# Contributing

Thanks for taking the time to improve FinalCheck. This is a small, safety-oriented project; small focused changes with tests are much easier to review than large rewrites.

## Setup

```bash
npm ci
cd desktop && npm ci && npm run setup:sqlite
```

`npm run setup:sqlite` rebuilds the `better-sqlite3` binding for Electron's ABI. Run it again after changing the Electron version.

## Checks before opening a PR

```bash
node scripts/run-tests.mjs
npm run lint
npm run typecheck
cd desktop && npx electron-vite build
```

All four must pass. New behavior needs a test; bug fixes need a regression test that fails without the fix.

## What we care about

- **Evidence over confidence.** A finding should say which file and line it came from, and whether it was measured, statically proven, heuristic, or not checked.
- **Fail closed.** If a check cannot run, say "not covered"/"not verified"; do not report a pass.
- **No hidden execution.** Do not run an audited project's tests or scripts without an explicit user approval boundary.
- **No secret echo.** Reports, logs, diagnostics, and test output must never contain usable credentials. Use synthetic values in tests.
- **Local first.** The desktop app works offline; do not add a mandatory cloud dependency.
- **One border per card** in the UI; follow the existing Tailwind/style conventions.
- **Both languages.** User-facing strings go through `t('中文原文')` and get an English entry under `desktop/src/renderer/i18n/en/`. AI output follows the user, not the UI language switch.
- **SQL is always parameter-bound.** Never concatenate or format external input into SQL.

## Pull requests

- Keep one logical change per PR; avoid unrelated formatting churn.
- Include the commands you ran and the result (test count, build result).
- For UI changes, attach a screenshot of the before/after state; the maintainer will also verify on a real window.
- Do not commit `desktop/config.json`, session databases, `workflow-runs/`, installer outputs, or `.mimosa/` state.
- By contributing, you agree that your contribution is licensed under the repository's Apache-2.0 license.

## Security reports

Do not open a public issue with exploit details. See `SECURITY.md`.
