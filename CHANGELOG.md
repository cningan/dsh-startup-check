# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-18

First stable release. The interface this promises to keep compatible is the
`plugin_check` tool: its options (`target`, `live`, `page`, `sweep`,
`killStray`) and the shape of the verdict it returns. Everything before this was
initial development, published as `0.4.x`.

### Changed

- README (both languages): document that the published package carries a signed
  provenance attestation, with the provenance badge linking to the registry's
  attestation endpoint for the current release.
- Publishing is now fully automated: a `v*` tag publishes through npm trusted
  publishing (OIDC) and opens the matching GitHub Release, so the npm version,
  the git tag and the release page stay in step.

### Notes

- `0.4.0` was published from a maintainer's machine because the very first
  publish cannot be done by CI — trusted publishing can only authenticate a
  package that already exists. `0.4.3` was the first CI release, and the first
  to carry a provenance attestation.

## [0.4.3] - 2026-09-18

*Pre-1.0 development release.*

First release published by CI, and the first with a signed provenance
attestation. `plugin_check` itself is unchanged — everything in this release is
about how the package is produced and shipped.

### Added

- `scripts/publish-dsh-startup-check.ps1`: an interactive maintainer wizard for
  the one publish only a human can perform (the first one), from a
  name-availability check through a `--dry-run` review to a typed `PUBLISH`
  confirmation.
- A tag-driven publish workflow using npm trusted publishing (OIDC), so no
  long-lived token is stored in the repository, gated behind the
  `NPM_TRUSTED_PUBLISHER_READY` repository variable.
- `CONTRIBUTING.md`: a Releasing section recording the three conditions a tag
  needs, each stated with the symptom it produces when missing.

### Fixed

- The publish job ran on Node 22, whose bundled npm (10.9.8) predates OIDC
  support (npm 11.5.1). The publish went out unauthenticated and failed with a
  bare `404 Not Found - PUT` that never mentioned authentication. The job now
  runs Node 24 and asserts the npm version before publishing.

## [0.4.0] - 2026-09-17

*Pre-1.0 development release. Also the first publish, done by hand: CI cannot
create a package that does not exist yet.*

First public release. Before this, the plugin lived only inside a private
harness profile, so this entry summarizes the state it was published at.

### Added

- `plugin_check` tool: static checks (plugin syntax, package structure, patch
  reference existence, config-tree assembly) plus optional smoke checks.
- Real-boot smoke (`live: true`): spawns an isolated
  `dsh --profile <p> --port 0 --no-open` instance and reads the `dsh web: <url>`
  it prints, without touching the running harness.
- Page-side smoke (`page: true`): opens the booted URL in headless Edge/Chrome
  over CDP and reports `Runtime.exceptionThrown`, console and browser-log
  errors, plus rendering evidence (body text length, `data-plugin` markers,
  `window.__DSH_BOOT__`) so that "zero errors" is distinguishable from "blank
  page".
- Shutdown confirmation: after a smoke run, the process table is read again and
  a leftover isolated instance is reported as `ok: false` with its PID.
- Stray-instance audit (`sweep: true`): lists isolated smoke instances, resident
  harness hosts and one-shot invocations; `killStray: true` kills only isolated
  `--port 0` instances, by exact PID.
- Bundled skill `plugin-fault-diagnosis` (a `bundled` skill provider, rank 600),
  shipping the "what to do after `ok: false`" playbook inside the package.

### Notes

- Windows-only: the instance audit uses PowerShell/WMI, the page-side smoke uses
  Edge/Chrome over CDP.
- The static checks target the `web` profile's `@local` plugin layout
  (`~/.dsh/profiles/web/plugins/**`).
- Documentation: bilingual README with a rendered banner and a before/after
  diagram (`assets/*.svg`), plus `docs/architecture.md` and its Chinese mirror.
  Every path is relative, so the images also render on the npm package page.

[Unreleased]: https://github.com/cningan/dsh-startup-check/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/cningan/dsh-startup-check/releases/tag/v0.4.0
