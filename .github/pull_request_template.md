<!-- Thanks for the pull request. Keep it to one logical change. -->

## What changed

<!-- One or two sentences. If it fixes an issue, write "Fixes #123". -->

## Why

<!-- The failure mode or need this addresses. -->

## How it was verified

<!--
  `npm test` is the baseline. If you exercised the change inside a real harness,
  say which check you ran and what it reported. Delete what does not apply.
-->

- [ ] `npm test` passes
- [ ] Exercised in a real harness: `plugin_check { ... }` → <!-- result -->

## Checklist

- [ ] New behaviour is covered by `test/tool-body-selftest.mjs` (or the PR explains why not)
- [ ] `CHANGELOG.md` has an entry under `[Unreleased]`
- [ ] Docs updated where user-visible behaviour changed (`README.md` / `README.zh.md`)
- [ ] Docs updated where internals changed (`docs/architecture.md` / `docs/architecture.zh.md`)
- [ ] Safety boundaries respected: no writes to the checked profile, no resident-host kills,
      no process matching by command-line text
