# Security Policy

## Scope

`dsh-startup-check` runs inside your DeepSeek Harness process. It can spawn
processes (`node --check`, `dsh --dump-config`, a headless browser) and reads
files under your harness profile (`~/.dsh/profiles/<profile>`). It never writes
to the profile it checks.

Security-relevant reports include, but are not limited to:

- A path by which `plugin_check` writes to, deletes from, or otherwise mutates
  the checked profile or any user file.
- A way to make `killStray: true` terminate a process other than an isolated
  `--port 0` smoke instance — in particular killing a resident harness host, or
  matching processes by anything other than exact process identity.
- Command or argument injection through tool input, a plugin directory name, or
  a process command line.
- Disclosure of profile contents, credentials, or environment variables through
  tool output or the bundled skill.

## Supported versions

The latest published minor version receives security fixes.

| Version | Supported |
|---|---|
| 0.4.x | ✅ |
| < 0.4 | ❌ |

## Reporting a vulnerability

Please **do not** open a public issue for a security report.

Use GitHub's private reporting: go to the repository's **Security** tab →
**Report a vulnerability**. If that is unavailable, contact the maintainer
through the address on their GitHub profile.

Include, as far as you can:

- the version (`npm ls dsh-startup-check`, or the `version` field of the
  installed `package.json`),
- your harness version (`dsh --version`) and OS,
- the exact tool call and the output you got,
- a minimal reproduction, and
- what you expected to happen instead.

You will get an acknowledgement within a few days. Fixes are released as a patch
version with a `CHANGELOG.md` entry; reporters are credited unless they ask
otherwise.
