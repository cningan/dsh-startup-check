# Architecture

[简体中文](architecture.zh.md) · **English**

## Overview

`dsh-startup-check` is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin that moves plugin
breakage discovery *ahead of* the restart. It registers one model-facing tool, `plugin_check`, which a coding
agent calls after installing, patching, or editing an `@local` plugin. The tool inspects the Web profile's plugin
tree **before** dsh is restarted, so a change that would make dsh fail to open is reported while it can still be
fixed in place.

The user-visible pain it removes is a short loop: install a plugin → the plugin is broken → the breakage only
surfaces on the next restart → the user manually disables plugins until dsh opens again. `plugin_check` runs the
same questions in advance: does every `lib/*.js` parse, is every `package.json` internally consistent, does every
`@local/*` package referenced by `cordis.patch.yml` exist on disk, does the composed config tree assemble, does a
real isolated instance print its `dsh web:` URL, does the page it serves render without client-side errors, and did
the instance it started actually exit?

The plugin also bundles a companion skill, `plugin-fault-diagnosis`, which is the "what to do after
`plugin_check` returns `ok:false`" playbook.

### What it is not

- **It is not a restart mechanism.** The plugin never restarts, reloads, or reconfigures the running profile. It
  reads it and it starts *separate* isolated instances. The running dsh keeps serving the code it booted with; see
  [Process model and safety](#process-model-and-safety).
- **It is not a hot-reload path.** The plugin is a host-side static plugin: code changes take effect on the next
  dsh restart.
- **It is not a general health monitor.** It runs only when the tool is invoked; there is no background timer,
  watcher, or polling loop.
- **It is not cross-platform today.** Syntax/structure/reference checks are portable, but the instance audit
  (`lib/instances.js`) is implemented for Windows only, and the page half probes Windows browser install paths.
- **It does not write to the profile it checks.** Every filesystem interaction with the inspected profile is a
  read. The only artifacts it creates are a throwaway browser profile directory under `%TEMP%` and short-lived
  child processes.
- **Its check names and details are Chinese strings.** The `plugin_check` output (check `name` and `detail`
  fields, and the tool description) is emitted in Chinese; only this document and the README are English.

## Runtime shape

The package is a host-only Cordis plugin. `package.json` declares
`exports["."].default = ./lib/index.js` and `main: ./lib/index.js`, and it has no `dsh.client` field, so there is
no client half, no browser bundle, and no Slots or theme work. The only `dsh` field it does declare is
`dsh.bundle.patch = ./cordis.patch.yml`: that is how `dsh plugin add` discovers the bundle and appends the package
to `dsh.profile.bundles`, which in turn is how the loader mounts `name: 'dsh-startup-check'` after every bundle
layer.

- **Identity and injected services.** `lib/index.js` exports `name = "startup-check"` (`lib/index.js:10`) and
  `inject = ["tools", "subprocess", "fs", "skills"]` (`lib/index.js:11`). All four are hard dependencies: the
  plugin waits until Cordis can supply them, and accesses them as declared `ctx` properties.
- **`apply(ctx)`** (`lib/index.js:128`) does exactly two things, both owned by the current Host Fiber:
  1. `ctx.skills.registerProvider(() => faultDiagnosisSkillProvider)` (`lib/index.js:129`) publishes the bundled
     skill.
  2. `ctx.tools.register(defineTool({ … }))` (`lib/index.js:130`) registers `plugin_check`.
- **Tool registration.** `defineTool` comes from `@deepseek-ai/dsh-tools` (`lib/index.js:1`, used at
  `lib/index.js:130`). The tool declares five optional boolean/string parameters — `target`, `live`, `page`,
  `sweep`, `killStray` (`lib/index.js:149-170`) — a JSON output schema whose renderer is
  `JSON.stringify(value)` (`lib/index.js:171-176`), and one `execute(args, exec)` body (`lib/index.js:177-426`)
  that returns `{ ok, checks }`.
- **`exec.signal`** is threaded from the tool call into every subprocess spawn so a cancelled tool call aborts
  its children (`lib/index.js:178`, and `signal` propagation at `lib/index.js:257`, `:277`, `:291`, `:295`,
  `:310`).
- **Bundled skill provider.** `SKILL_PROVIDER_NAME = "dsh-startup-check"` (`lib/index.js:90`) is the
  *provider* name; the skill itself is named `plugin-fault-diagnosis` (`lib/index.js:97`). The provider exposes
  `list()` and `get()` (`lib/index.js:113-125`), and `get()` reads the body from
  `assets/plugin-fault-diagnosis.md` (`lib/index.js:91`, read at `lib/index.js:123`). The candidate is shipped
  with `source: "bundled"` (`lib/index.js:105`) and `rank: BUNDLED_SKILL_RANK` (`lib/index.js:107`), imported
  from `@deepseek-ai/dsh-skill` (`lib/index.js:2`). The shape deliberately mirrors the official bundled provider
  `@deepseek-ai/dsh-skill-badge`.

**Why the skill is bundled rather than installed into a user skill root.** The skill only means anything while
this plugin — which owns the tool whose output the skill explains — is loaded. Shipping it inside the package
makes the two live and die together, so a disabled plugin never leaves a stale manual behind. A same-named skill
under the user's skill root would still win over the bundled one, because layer resolution merges by proximity
and the lower rank number wins; the bundled copy has rank `BUNDLED_SKILL_RANK` (600), and a disk skill ranks
lower.

**Why the engine is split across three `lib/` files.** `lib/smoke.js` and `lib/instances.js` deliberately
`import` no dsh package. `spawn` is dependency-injected from the caller, so the identical algorithm runs both
inside the dsh host process (passed `ctx.subprocess.spawn`) and from an ordinary Node script (passed a
`node:child_process` adapter). There is exactly one implementation of the smoke engine and one of the process
audit; the plugin is a *consumer* of them, not a second copy. `lib/page-smoke.js` is the one file that reaches
for Node built-ins directly (`WebSocket`, `node:http`, `node:net`, `mkdtempSync`/`rmSync`), a technical debt
recorded in its own header comment: neither `ctx.fs` nor `ctx.subprocess` offers a "create a temporary
directory" or WebSocket primitive. Should dsh grow a proper mechanism, that file should migrate back to `ctx.*`.

## Object map

| Object | Responsibility | Location | Lifecycle/state |
|---|---|---|---|
| `name` / `inject` | Plugin name `startup-check`; requires `tools`, `subprocess`, `fs`, `skills` | `lib/index.js:10-11` | Runtime injection |
| `PROFILE` / `PROFILE_DIR` / `PLUGINS_DIR` / `PATCH_FILE` | The fixed `web` profile plus its `plugins/` directory and `cordis.patch.yml` | `lib/index.js:13-16` | Static path configuration |
| `run(ctx, argv, …)` | Runs a command and collects exit code / stdout / stderr (`spawn` carries an explicit `cwd`) | `lib/index.js:26-40` | Temporary per check |
| `readFileText` / `listDirNames` / `fsPath` | Read text, list a directory, and resolve a process path through `ctx.fs` | `lib/index.js:51-78` | Temporary per check; restored after an accidental deletion — see [Regression / testing](#regression--testing), layer 3 |
| `SKILL_PROVIDER_NAME` / `SKILL_CANDIDATE` / `faultDiagnosisSkillProvider` | Provider for the bundled skill `plugin-fault-diagnosis` (`source: "bundled"`, `rank: BUNDLED_SKILL_RANK`, body read from `assets/plugin-fault-diagnosis.md`) | `lib/index.js:90-126` | Registered on `ctx.skills` during `apply`; owned by the current Host Fiber |
| `plugin_check` tool | Organizes the static checks, the shutdown confirmation, and the stray-instance audit; returns `{ ok, checks }` | `lib/index.js:131-427` | Registered; never writes the profile it inspects |
| `target` / `live` / `page` / `sweep` / `killStray` parameters | Check one plugin only / boot an isolated instance / run the page half too (`page` implies `live`) / audit only / precisely clean up isolated leftovers during an audit | `lib/index.js:150-169`, `:179-183`, `:303-423` | Per-call input |
| `LIVE_TIMEOUT_MS` / `PAGE_LIVE_TIMEOUT_MS` / `PAGE_OBSERVE_MS` | Host boot budget 12 s / 30 s when the page half runs / page observation window 15 s | `lib/smoke.js:23-27` | Static constants |
| `SHUTDOWN_TIMEOUT_MS` / `SHUTDOWN_RETRY_MS` | Upper bound of 8 s waiting for the instance to exit / 2.5 s second-layer observation window | `lib/smoke.js:29-31` | Static constants |
| `readCollected` / `collectedText` | Read collected output by byte offset (the `SubprocessOutputReader` contract — non-destructive) | `lib/smoke.js:36-50` | Reused utility functions |
| `verifyShutdown(handle, timeoutMs)` | Wraps up and **confirms** the instance exited: `done` plus `waitForExit(signal)` plus a bounded wait; if still running, sends a second `terminate()` and observes again; returns `{ exited, ms, outcome, detail }` | `lib/smoke.js:76-109` | Every smoke teardown; proves only that the *direct child / managed scope* is quiescent — the process table is the final authority |
| `liveSmoke(options)` | Boots the isolated instance, **reads** the `dsh web: <url>` line while it runs, hands the URL to the page half when asked, wraps up, and confirms exit (the result carries `shutdown`, including `instanceUrl`) | `lib/smoke.js:124-257` | Runs only for `live`/`page`; temporary process |
| `STALE_SMOKE_SECONDS` | The "stray" criterion: a legitimate isolated smoke lives tens of seconds, so surviving past 300 s can only mean nobody collected it (only instances older than this are cleaned, to avoid killing another session's in-flight smoke) | `lib/instances.js:39` | Static constant |
| `parseInvocation` / `classifyCommandLine` / `commandLinePort` | Parse a Windows command line and classify it by **process identity** (`node.exe` plus a first argument of `@deepseek-ai/dsh/lib/bin.js`) into `smoke` / `host` / `other` | `lib/instances.js:46-83` | Pure functions; see the negative control in [Regression / testing](#regression--testing) |
| `listDshInstances(options)` | Read-only audit: runs a PowerShell CIM query listing every `node.exe`, then classifies (ages are computed to integer seconds inside PowerShell); non-Windows or a failed query returns `ok:false` ("not tested", not "no leftovers") | `lib/instances.js:126-181` | Called 2–3 times per `live`/`sweep` invocation |
| `killPid(options)` | Precise cleanup: `taskkill /PID <pid> /T /F` for one pid, then re-reads the process table to confirm it is gone; refuses invalid pids and the current process | `lib/instances.js:191-214` | Used only with `killStray:true` and only for `smoke`-kind instances |
| `findBrowser()` | Finds an Edge/Chrome executable (Edge first); returns `undefined` when none is found | `lib/page-smoke.js:37-46` | Pure function |
| `pickFreePort` / `httpGetJson` / `openSocket` | Picks a free CDP port (`node:net`), reads `/json/list` (`node:http`), opens a WebSocket (global `WebSocket`, falling back to `ws` on older Node) | `lib/page-smoke.js:51-114` | Temporary per smoke |
| `pageSmoke(options)` | Headless Edge plus CDP: opens a session, navigates, collects `Runtime.exceptionThrown` / console / log errors, takes rendering evidence, removes the temporary directory; returns `tested` (whether the browser layer actually ran) | `lib/page-smoke.js:138-295` | Runs only with `page:true` |
| Rendering evidence (`evidence`) | `{ title, hasBoot, bootKeys, bodyText, pluginMarkers }`, used to distinguish "zero errors" from "blank page" | `lib/page-smoke.js:248-267`, consumed at `lib/smoke.js:217-219` and `lib/page-smoke.js:291-294` | Temporary per smoke |

## Check pipeline

Checks numbered 1–8 below match the numbering used in the tool description and the source comments. Checks 1–4
always run; 5 and 6 require `live:true` and `page:true`; 7 accompanies `live`; 8 runs for `live` or `sweep`.

**1. Syntax — every `@local` plugin's `lib/*.js`.**
For each plugin directory under `PLUGINS_DIR`, every `*.js` file in `lib/` is resolved through `ctx.fs` and run
through `node --check <path>` via `run()` (`lib/index.js:247-261`). Both host and client sources are checked,
because they are all `.js` files in `lib/`. Failures are concatenated (each trimmed to 400 characters of stderr)
into a single `语法检查` check that fails the run (`lib/index.js:263-268`). `target` narrows the loop to one
plugin name (`lib/index.js:213`).

**2. `package.json` structure — every `@local` plugin.**
Per plugin, the manifest is read and parsed (`lib/index.js:215-226`); a missing manifest is a failure, and so is
invalid JSON. Then (`lib/index.js:227-246`):
- `pkg.name` must be a string with the `@local/` prefix;
- `pkg.main` (default `lib/index.js`) must resolve to an existing file;
- if `pkg.dsh.client` is declared, `pkg.exports["./client"]` must exist, and the file it points at (its
  `default`, or the spec itself) must resolve.

Syntax and structure results are reported as two separate checks (`语法检查`, `package.json 结构`) so a single bad
plugin does not blur the two failure modes.

**3. Reference existence — `cordis.patch.yml`.**
`PATCH_FILE` is read; if it cannot be read, the check fails outright (`lib/index.js:188-191`). Otherwise every
`name: '@local/…'` occurrence is collected and de-duplicated with a regex (`lib/index.js:193-194`), and each
reference must correspond to a real directory name under `plugins/` (`lib/index.js:197-198`). Plugin bodies live
in `profiles/web/plugins`; the optional `node_modules/@local` junctions are deliberately *not* consulted, because
the loader resolves `@local/*` from the plugin directory and some plugins load without a junction.

**4. Config tree assembly.**
`cmd.exe /c dsh --profile web --dump-config` is executed from `PROFILE_DIR` with a 256 KiB stdout cap
(`lib/index.js:277`). A non-zero exit fails the check with up to 800 characters of stderr or stdout
(`lib/index.js:278-280`); success is reported with the number of non-empty output lines (`lib/index.js:282-283`).

**5. Real-boot smoke (`live:true`).**
Before booting, the process table is read once to establish a baseline (`lib/index.js:304`, `auditInstances` at
`lib/index.js:291`). Then `liveSmoke` spawns
`cmd.exe /c dsh --profile web --port 0 --no-open` (`lib/smoke.js:141`) with a 12 s boot budget — 30 s when the
page half will also run (`lib/smoke.js:128`, `:134`). Because `--port 0` lets the OS assign the port, the URL can
only be learned from the child's own output, so the engine polls the collected stdout **while the process is
still running** and matches `/dsh web:\s*(http:\/\/\S+)/` on the accumulated text
(`lib/smoke.js:150-169`). The check passes when that URL appears (`lib/smoke.js:171`). Stderr lines matching
`error|fail|pending|waiting for service|did not activate|throw` are collected as warnings and surfaced in the
detail, but do **not** by themselves fail the check — the pass criterion is that the instance could print its URL
(`lib/smoke.js:200-210`). Failure detail includes the exit code and a stderr/stdout excerpt
(`lib/smoke.js:189-199`).

**6. Page smoke (`page:true`, implies `live`).**
The URL from check 5 is handed to `pageSmoke`. It locates a browser (`findBrowser`, Edge before Chrome,
`lib/page-smoke.js:29-46`), creates a one-shot browser profile under `%TEMP%` (`lib/page-smoke.js:151`), picks a
free CDP port (`lib/page-smoke.js:152`), and launches headless Edge/Chrome with `--headless=new
--remote-debugging-port=<port> --user-data-dir=<temp>` (`lib/page-smoke.js:159-172`). It waits (up to 20 s) for
the debug target to appear at `/json/list` (`lib/page-smoke.js:175-190`), connects the CDP WebSocket
(`lib/page-smoke.js:193-198`), and — critically — **enables the domains before navigating** (`Runtime.enable`,
`Log.enable`, `Page.enable`, then `Page.navigate`, `lib/page-smoke.js:238-244`), so errors thrown during load are
actually observed:
- `Runtime.exceptionThrown` → collected as `[exception] …`;
- `Runtime.consoleAPICalled` of type `error`/`warning` → collected as `[console.error] …` / `[console.warning] …`;
- `Log.entryAdded` at level `error`/`warning` → collected as `[log.…] …`.

This is where client-only breakage such as `failed to apply loader entry …` becomes visible; the host process
never prints it. After the observation window (15 s by default, `lib/page-smoke.js:140`, `:244`) a probe evaluates
the rendering evidence (`lib/page-smoke.js:248-267`). The verdict requires **no page errors and, when evidence
exists, actual rendering**: `rendered` is `bodyText > 0 || hasBoot === true`, and the check fails if the page is
blank even with zero errors (`lib/page-smoke.js:291-294`). "Not tested" is kept distinct from "failed": if no
browser is found, the debug target never appears, or the socket cannot connect, the result carries
`tested:false`, `liveSmoke` reports `pageOk:true, pageTested:false` with the reason, and the run is not counted as
a plugin failure (`lib/smoke.js:220-231`). The `finally` block closes the socket, terminates the browser, waits
for it, and `rmSync`s the temporary profile (`lib/page-smoke.js:270-286`).

**7. Shutdown confirmation (accompanies `live`).**
After the smoke, the process table is read again (`lib/index.js:328`). The audit is performed by
`listDshInstances` running a PowerShell CIM query:
`Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'node.exe' } | Select-Object ProcessId,
ParentProcessId,@{n='AgeSeconds';e={[int]($now-$_.CreationDate).TotalSeconds}},CommandLine | ConvertTo-Json
-Compress -Depth 3` (`lib/instances.js:91-94`). Rows are classified by `classifyCommandLine`
(`lib/instances.js:67-75`). Instances are split into "ours" (present now, absent from the baseline) and "already
there" (present in the baseline) — the baseline is the only evidence that attributes a pid to this run
(`lib/index.js:329-336`). Outcomes:
- process table unreadable → the check reports `ok:true` with "not tested" plus the engine-side observation;
- no baseline → "not tested", failing only if isolated instances exist at all (it cannot tell whose they are);
- baseline and no new instances → pass, with the engine's `shutdown.detail`;
- baseline and new instances remain → **fail**, listing pids and ages, and naming the consequence: a live
  instance holds the session write lease, so a new session resume fails with `SessionAlreadyOwnedError`
  (`lib/index.js:380-390`).

**8. Stray-instance audit (`sweep:true`, or alongside `live`).**
Runs for `live || sweep` (`lib/index.js:327`). It boots nothing; it reads the process table and reports counts of
isolated smoke instances, resident web hosts (with ports where known), and transient invocations. The default is
report-only. `killStray:true` cleans exactly two groups (`lib/index.js:341-356`):
1. instances leaked by this run — attributable because they appear after the baseline;
2. pre-existing instances older than `STALE_SMOKE_SECONDS` (300 s), since a legitimate smoke lives tens of
   seconds.

Pre-existing instances younger than the threshold may belong to another session's in-flight smoke, so they are
reported and never killed. Web hosts are never touched. After killing, the table is read a third time to verify
the pids are gone, and any kill whose verification failed is labelled "result not confirmed"
(`lib/index.js:348-354`, `:397-401`).

## Process model and safety

**Instance spawning.** The isolated instance is always launched as
`cmd.exe /c dsh --profile web --port 0 --no-open` (`lib/smoke.js:141`) — the same `cmd.exe /c` shape the config
check uses (`lib/index.js:277`). `--port 0` makes the OS assign a free port, which is what keeps the smoke off the
running GUI's port; `--no-open` stops it from opening a browser. A hard timer aborts the whole smoke at the boot
budget plus (when the page half runs) the observation window and browser teardown, and the outer `exec.signal` is
forwarded as an abort listener so a cancelled tool call takes its children down (`lib/smoke.js:132-136`).
`liveSmoke` never passes `env`, so the instance inherits the host's `~/.dsh`.

**Why shutdown must be verified against the process table.** `terminate()` only *asks*: in the
`SubprocessHandle` contract it returns `void`, and `waitForExit()` is what "observes the managed scope actually
going quiet". More importantly, the child we spawn is `cmd.exe`, and the real instance is its **grandchild** —
`handle.done` proves only that `cmd.exe` is gone, not that `node … dsh/lib/bin.js --port 0` is. The lingering
process shape actually observed in practice was exactly "parent dead, instance still running". `verifyShutdown`
therefore gives only the *engine-side* observation (`{exited, ms, outcome, detail}`, `lib/smoke.js:76-109`); the
authoritative answer comes from the before/after process-table comparison in check 7. The stakes are concrete: on
Windows the session write lease is a **named kernel semaphore** which is released only when the holding process
exits and which deliberately has no expiry, so one surviving instance permanently blocks session resume with
`SessionAlreadyOwnedError`.

**What `killStray` may kill.** Only instances classified `smoke`, meaning `node.exe` whose first argument is
`@deepseek-ai/dsh/lib/bin.js` and whose arguments contain `--port 0` (`lib/instances.js:26-28`, `:72`), and only
in the two groups described in check 8. Killing goes through `killPid`, which validates the pid (rejecting
non-integers, non-positive values, and the current process), runs `taskkill /PID <pid> /T /F`
(`lib/instances.js:191-214`), and then re-reads the process table to confirm the pid is gone — so a "killed"
result means verified-gone, and an unverifiable result is reported as such. Resident web hosts and `other`
transient invocations are never killed by any code path.

**Why classification is by process identity, never by "the command line mentions dsh".** A hand-written cleanup
script that matched `-match 'dsh|deepseek|harness'` once killed four unrelated processes, because a directory in
the path happened to contain `dsh`. Any substring match on the command line is therefore treated as unsafe.
`classifyCommandLine` requires the parsed *first argument* to match
`/@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/i` (`lib/instances.js:26`, `:70`); anything that does not, including a
pwsh diagnostic script or a `node -e` one-liner that merely mentions dsh, is not a DSH process at all. The
classification is also deliberately conservative: among real DSH processes, anything that is neither an isolated
smoke (`--port 0`) nor a recognised transient invocation (`--dump-config`, `--dump-default-config`, `--help`,
`-h`, or a `plugin …`/`plugin` command, `lib/instances.js:32`) is counted as `host` — a resident instance that
might be the user's open window. Over-counting hosts is safe because hosts are never cleaned automatically.

## External dependencies

| Dependency | Used for | Evidence |
|---|---|---|
| `@deepseek-ai/dsh-tools` `defineTool` | Declares the `plugin_check` contract | `lib/index.js:1`, used at `lib/index.js:130` |
| `@deepseek-ai/dsh-skill` `BUNDLED_SKILL_RANK` | In-layer rank of the bundled skill (600) | `lib/index.js:2`, used at `lib/index.js:107` |
| `skills` service (`ctx.skills.registerProvider`) | Publishes the bundled `plugin-fault-diagnosis` skill | `lib/index.js:11`, `:129` |
| `subprocess` service (`ctx.subprocess.spawn`) | Runs `node --check`, `dsh --dump-config`, the isolated instance, the PowerShell audit, `taskkill`, and the headless browser | injected `lib/index.js:11`; used `lib/index.js:27`, `:290`; `lib/smoke.js:140`; `lib/instances.js:103`; `lib/page-smoke.js:159` |
| `fs` service (`ctx.fs.resolve` / `readText` / `listDir`) | Reads the patch and manifests, lists `plugins/` and `lib/`, resolves process paths | injected `lib/index.js:11`; used `lib/index.js:53-54`, `:63-64`, `:74` |
| `node` and `dsh` commands | Syntax check / config-tree assembly / isolated instance | `lib/index.js:257`, `:277`, `lib/smoke.js:141` |
| `powershell` + WMI (`Get-CimInstance Win32_Process`) | Instance audit: lists `node.exe` with command lines, computing age to integer seconds inside PowerShell | `lib/instances.js:91-94`, invoked at `lib/instances.js:138` |
| `taskkill /PID <pid> /T /F` | Precise cleanup of isolated smoke leftovers (only under `killStray:true`, only for `smoke`-kind instances) | `lib/instances.js:198` |
| Session-persistence write lease (`dsh-session-persistence-jsonl`) | Explains why a surviving instance blocks a new session: on Windows the lease is a named kernel semaphore, released only on holder exit, deliberately without an expiry ⇒ `SessionAlreadyOwnedError` | the official package's implementation (a diagnostic basis, not a code dependency) |
| Web profile `cordis.patch.yml` | Read passively to verify that referenced `@local` package directories exist | `lib/index.js:16`, read at `lib/index.js:188`, matched at `:193-198` |
| Headless Edge/Chrome + CDP | Page-side errors and rendering evidence | `lib/page-smoke.js` (`--headless=new --remote-debugging-port`, `lib/page-smoke.js:160-167`) |
| `node:fs` `mkdtempSync` / `rmSync`, `node:http`, `node:net`, global `WebSocket` (fallback `ws`) | CDP transport and the throwaway browser profile (registered technical debt; migrate to `ctx.*` if dsh gains the primitives) | `lib/page-smoke.js:21-26`, `:51-114` |

## Known limitations

**Fixed page observation window.** The page half observes for a fixed 15 s
(`PAGE_OBSERVE_MS`, `lib/smoke.js:27`). `pageSmoke` and `liveSmoke` both accept an `observeMs` override
(`lib/smoke.js:129`, `lib/page-smoke.js:140`), but the tool does not expose it as a parameter. Registered
capability, not implemented: if slow-loading scenarios appear, add an `observeMs` tool parameter.

**Non-Edge/Chrome browsers.** Only the common install paths for Edge and Chrome are probed
(`lib/page-smoke.js:29-34`). When neither is found the page half is skipped and a note is recorded — it is not
reported as a plugin failure.

**Non-Windows instance audit.** `listDshInstances` is implemented for Windows only (WMI plus PowerShell). On any
other platform it returns `ok:false` ("not tested"), and check 7 degrades to reporting only the engine-side
observation (`lib/instances.js:128-135`). Implementing it means writing a per-platform process-table query.

**DSH_HOME isolation of the isolated instance.** `liveSmoke` currently lets the instance inherit the host's
`~/.dsh` (no `env` is passed, `lib/smoke.js:125`). The benefit is that what gets validated is the *real* home
directory. The cost is that a leftover instance shares sessions and storages with the GUI. A mirror-home approach
exists outside the plugin (the command-line wrapper accepts a `--home=` override and `liveSmoke` already supports
an `env` option, `lib/smoke.js:120`), but whether to adopt it inside the plugin is an open product decision, not
an implemented behaviour.

**No automatic cleanup of host-side leftovers.** The audit cleans only `--port 0` isolated smoke instances.
Resident hosts — which may be the window the user is working in — are always reported and never killed.

**Chinese-only tool output.** Check names, details, notes, and the tool description are Chinese strings
interpolated into the returned JSON; there is no localization layer.

## Regression / testing

There is no automated test file shipped with the plugin. Verification is organised in three layers, ordered by
cost:

**Layer 1 — engine self-tests (fast, with negative controls).** The smoke engine and the instance audit each
have a self-test in the public repository:
- the page-smoke self-test runs positive control (a clean page reports zero errors), negative controls (a page
  that throws, and a `console.error`, must both be caught), and a blank-page control (zero errors but empty body
  text must be judged a failure). All four must report `ok:true` before the detector can be trusted;
- the instance-audit self-test covers the classifier: negative controls (a pwsh diagnostic script, or a
  `node -e` one-liner, that merely mentions dsh must not be classified as DSH), positive controls (sample
  `smoke`/`host`/`other` command lines classify correctly, and a running host must classify as `host` — otherwise
  `killStray` could kill it), guards (`killPid` refuses the current process and invalid pids), and an optional
  `--stray` mode that really creates an uncollected isolated instance (parent exits, instance stays), requires
  the audit to find it, kills it by exact pid, and re-checks that zero remain.

**Layer 2 — the real profile.** Escalating in cost:
`plugin_check` (the four static checks) → `plugin_check({live:true})` (the isolated instance boots and its
shutdown is confirmed) → `plugin_check({page:true})` (the page has zero errors and non-empty rendering evidence)
→ `plugin_check({sweep:true})` when leftovers are suspected.

**Layer 3 — tool-body self-test (a fresh process, really calling the tool).** This is the machine-checkable layer,
and it lives in this public repository as `test/tool-body-selftest.mjs`. It copies `lib/` into a stub package
following an explicit file list at the top of the script, builds a stub `ctx` (including a **stub process table**:
a lingering smoke instance and a host, with the smoke instance disappearing after `taskkill`), then — in a
**brand-new Node process** — calls `apply()` and **actually invokes `execute()`**. It prints `VERDICT: OK` only
on success, and also reports the skill provider's `rank / bytes / whenToUse`. Run with `--plugin <dir>` it acts
as a negative control: a plugin containing broken code must throw.

Layer 3 exists because layers 1–2 cannot see its blind spot. `plugin_check --live` proves only that the *tree
boots*; it never executes the tool's function body, and a running dsh keeps serving the code it booted with. So a
source-level break can pass `node --check`, pass all five `plugin_check` checks, and still crash on the first real
call after the next restart. This was not hypothetical: refactoring `liveSmoke` into `lib/smoke.js` deleted the
`readFileText` / `listDirNames` / `fsPath` helpers while leaving their call sites in place — every check stayed
green, and the tool would have thrown `ReferenceError: readFileText is not defined` on its first invocation after
a restart. Restoring the helpers (`lib/index.js:51-78`, with the reason recorded in the comment at
`lib/index.js:42-50`) and reproducing "crashes before the fix, passes after" is exactly what layer 3 is for. The
same discipline applies to any plugin with real logic in a tool body. When adding or renaming files under `lib/`,
the copy list at the top of that self-test must be updated in step, or it fails with `ERR_MODULE_NOT_FOUND`.

**Two hard-won contracts, both worth a regression check of their own:**

- **`ctx.subprocess.spawn` requires an explicit `cwd` (DSH 0.1.5).** The spec's `cwd` is passed straight into
  the environment validation (`validateNoNullByte("options.cwd", spec.cwd)`, i.e. `spec.cwd.includes("\0")`), so
  an omitted `cwd` throws `Cannot read properties of undefined (reading 'includes')` before launch — surfacing as
  the whole tool returning a `TypeError`, which looks like a broken tool rather than a missing spawn field. Both
  call sites carry `cwd` explicitly: `run()` at `lib/index.js:29` and `liveSmoke()` at `lib/smoke.js:142`. The
  engine-side modules document `cwd` as a required option for the same reason (`lib/smoke.js:115`,
  `lib/instances.js:122`, `lib/page-smoke.js:131`).
- **Collected output is read with `readFrom(offset)`, not `finalize()`.** The `ctx.subprocess` collected-output
  reader contract is `{text, nextOffset, lossy}` read by byte offset and **non-destructive**
  (`SubprocessOutputReader`); `finalize()` is not part of that contract, and on 0.1.5 it measurably returned an
  empty string, which meant old code always saw empty stdout/stderr. Non-destructive offset reads are also what
  make the live smoke possible at all: the page half needs the URL *while the instance is still running*
  (`lib/smoke.js:36-50`, used in the polling loop at `lib/smoke.js:157-160` and after exit at
  `lib/smoke.js:187`, `lib/instances.js:113-114`).

**"Not tested" and "failed" must stay separate.** When the browser is missing, cannot start, or the debug port
does not connect, the page result is `tested:false`; `liveSmoke` in turn reports `pageOk:true, pageTested:false`
with the reason in the detail. An infrastructure problem must never be reported as a plugin problem. The same
rule applies to the process table: an unreadable table yields `ok:false` on the audit, which is surfaced as "not
tested" rather than "no leftovers".

## Maintenance

This document must be updated whenever the check scope, the parsing rules, or the injection contracts of
`lib/smoke.js`, `lib/page-smoke.js`, and `lib/instances.js` change. In particular, keep three statements
accurate: plugin bodies live in `plugins/` while `node_modules/@local` junctions are optional; there are two
distinct boot budgets (plus the shutdown and stale-instance timeouts); and the engine exists exactly once, in
this package, with its `spawn` injected by the caller.
