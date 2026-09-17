# dsh-startup-check

[简体中文](README.zh.md) · **English**

> Pre-flight check for a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) profile's plugin tree — catch "I installed a plugin, now the harness won't start" **before** you restart.

`dsh-startup-check` is a DSH plugin (npm package). It gives the model a single
tool — **`plugin_check`** — that inspects the plugin tree your harness will boot
from, and optionally boots a real, isolated instance to prove it comes up. It
also bundles the **`plugin-fault-diagnosis`** skill: the playbook for what to do
after a check fails.

---

## The problem

Installing or editing a DSH plugin is a leap of faith:

1. you add a plugin (or edit one),
2. you restart the harness,
3. and *then* you find out it doesn't boot — sometimes with a blank page and no
   obvious error.

By that point the harness you were working in is gone, and the diagnosis happens
under pressure.

`plugin_check` moves that discovery to **before the restart**, where the model
can still read the code and fix it.

## What it checks

| # | Check | What it catches |
|---|---|---|
| 1 | **Syntax** | every plugin `lib/*.js` fails `node --check` (typos, TypeScript/JSX in a plain-JS plugin, …) |
| 2 | **Package structure** | missing `main` target, `dsh.client` declared without an `exports["./client"]` entry, wrong package-name prefix |
| 3 | **Patch references** | `cordis.patch.yml` references a plugin directory that no longer exists (renamed/removed/misspelled) |
| 4 | **Config-tree assembly** | `dsh --profile <p> --dump-config` fails — the loader cannot compose the tree at all |
| 5 | **Real-boot smoke** (`live: true`) | the isolated instance never prints its `dsh web: <url>` |
| 6 | **Page-side smoke** (`page: true`) | the page throws, logs errors, or renders nothing — client-side plugin failures the host never sees |
| 7 | **Instance shutdown** (with `live`) | the isolated instance did **not** actually exit (verified against the process table, not just "I asked it to stop") |
| 8 | **Stray-instance audit** (`sweep: true`) | leftover isolated smoke instances, plus a report of live harness hosts — *report only* unless you ask |

The tool returns structured JSON: `{ ok, checks: [{ name, ok, detail }] }`, where
`ok` is the single verdict signal.

### Safety

`plugin_check` is **read-only with respect to your profile**. It never restarts
or touches the harness you are using. The smoke checks spawn a *separate*
instance on an OS-assigned port (`--port 0`, `--no-open`) with a hard timeout,
then verify by process table that it really exited. Cleanup (`killStray: true`)
kills **only** isolated `--port 0` smoke instances, by exact PID; a resident
harness host is never killed.

## Requirements

- **DeepSeek Harness** with the `web` profile (`~/.dsh/profiles/web`).
- **Windows.** The instance audit uses PowerShell/WMI and the page-side smoke
  uses headless Edge/Chrome over CDP; neither is implemented for other
  platforms yet. `plugin_check` is installed as a Windows-only package.
- **Node.js ≥ 22** (the harness's own engine).
- Edge or Chrome installed, if you want the page-side check (optional).

## Install

```bash
dsh plugin --profile web add dsh-startup-check
```

`dsh plugin` is the harness's profile-plugin manager: it forwards to `pnpm`
inside the profile directory and, because this package declares
`dsh.bundle.patch`, adds it to the profile's bundle stack automatically.

**Restart the harness afterwards** — installing a plugin changes
`dsh.profile.bundles`, which is read at boot.

Then ask the model to check the tree, or call the tool yourself:

```
plugin_check                      # static checks only (fast)
plugin_check { live: true }       # + boot an isolated instance (~12s)
plugin_check { page: true }       # + headless-browser page check (~30–45s, implies live)
plugin_check { sweep: true }      # + audit live DSH processes (~1–2s)
plugin_check { live: true, killStray: true }   # also clean up this run's leftovers
```

## What "ok" means — and what it does not

- `ok: true` means *the checks that ran* passed. A static-only run says nothing
  about runtime behaviour; only `live` proves the tree boots.
- **"Not measured" is not "failed".** If no browser is found or the process
  table is unreadable, the affected check reports why and is treated as
  untested (`tested: false`) instead of being blamed on your plugins.
- The static checks inspect `~/.dsh/profiles/web/plugins/**` — the `@local`
  plugin layout. Plugins installed from npm into the profile's `node_modules`
  are not part of checks 1–3 (the config-tree and smoke checks do cover them).
- The profile is currently fixed to `web`. Pointing the checks at another
  profile is open work.

See [`docs/architecture.md`](docs/architecture.md) for the full design, the
lifecycle of every object, and the known limitations.

## Development

```bash
git clone https://github.com/cningan/dsh-startup-check.git
cd dsh-startup-check
npm test        # node --check on every lib file + the tool-body self-test
```

`npm test` runs [`test/tool-body-selftest.mjs`](test/tool-body-selftest.mjs): it
stages `lib/` in a throwaway harness with stubbed `@deepseek-ai/*` imports and a
stubbed `ctx`, then drives `apply()` and the tool's `execute()` in a fresh Node
process. This is the layer that neither `node --check` nor a boot smoke can see:
a running harness keeps serving the code it booted with, so a broken tool body
stays green until the next restart.

To iterate against a live harness, edit the plugin in
`~/.dsh/profiles/web/plugins/dsh-startup-check/`, then run
`plugin_check { live: true }` and restart.

Contributions are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md) and the
[`CHANGELOG.md`](CHANGELOG.md).

## License

[MIT](LICENSE) © cningan
