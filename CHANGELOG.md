# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.4.0] - 2026-09-11

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

[Unreleased]: https://github.com/cningan/dsh-startup-check/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/cningan/dsh-startup-check/releases/tag/v0.4.0
