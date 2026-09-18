# Contributing to dsh-startup-check

Thanks for taking the time to contribute. This document describes how to get a
change from "I have an idea" to "it is merged".

## Ways to contribute

- **Bug reports** — [open an issue](https://github.com/cningan/dsh-startup-check/issues/new/choose).
- **Feature requests** — open an issue describing the problem, not just the
  solution. This project prefers a small, sharp surface.
- **Pull requests** — bug fixes, documentation, and platform support (macOS and
  Linux are open work; see the roadmap in the issues).

## Development setup

Requirements: Windows, Node.js ≥ 22, and a DeepSeek Harness installation
(`dsh` on `PATH`) if you want to exercise the live checks.

```bash
git clone https://github.com/cningan/dsh-startup-check.git
cd dsh-startup-check
npm test
```

`npm test` runs `node --check` over every file in `lib/` and then
`test/tool-body-selftest.mjs`, which drives `apply()` and the tool's `execute()`
in a fresh Node process against a stubbed context. Keep both green.

### Trying your change inside a real harness

The repository *is* the plugin: symlink or copy it into a profile's `plugins/`
directory and restart the harness.

```powershell
# from an elevated or developer-mode shell, if you want a junction
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\plugins\dsh-startup-check" -Target <this-repo>
```

Then run `plugin_check { live: true }` and restart the harness. Remember that a
running harness serves the code it booted with — restart before concluding that
an edit did nothing.

## Pull request checklist

- [ ] `npm test` passes.
- [ ] New behaviour is covered by `test/tool-body-selftest.mjs`, or the PR
      explains why it cannot be.
- [ ] `CHANGELOG.md` has an entry under `[Unreleased]` (see below).
- [ ] Docs updated: `README.md` / `README.zh.md` for user-visible behaviour,
      `docs/architecture.md` / `docs/architecture.zh.md` for internals.
- [ ] No new hard-coded paths, no new dependency without a reason in the PR
      description.

## Commit messages

Conventional Commits are welcome but not required. What *is* required: one
commit per logical change, and a subject line that says what changed and why in
plain language.

```
fix: verify shutdown against the process table, not just handle.done

terminate() only asks the child to stop. When the child is `cmd.exe /c dsh`,
the real instance is a grandchild and can outlive it, holding a session write
lease. Read the process table before and after the run instead.
```

## Changelog entries

Add a bullet under `## [Unreleased]` in the appropriate section (`Added`,
`Changed`, `Fixed`, `Removed`). Write for users: what changed, not which file
changed.

## Scope

`plugin_check` is deliberately conservative about what it touches. Changes that
would write to the checked profile, kill a resident harness host, or match
processes by anything other than process identity will be rejected — those are
the design's safety guarantees, not implementation details.

## Releasing (maintainers)

Three things have to hold before a tag can publish itself. Each one was learned
by hitting it, so they are stated with the symptom they produce.

### 0. npm CLI 11.5.1 or newer, in both places

OIDC token exchange only exists from npm **11.5.1**. Two traps:

- **In CI**: the Node 22 line still bundles npm 10 (Node 22.23.2 ships npm
  10.9.8). The workflow pins `node-version: '24'`, which bundles npm 11.19, and
  asserts the version before publishing.
- **On your machine**: with an older npm, `npm trust github` silently omits the
  permission list — the relationship is created, `npm trust list` shows the
  claims, and publishing still fails. Upgrade with `npm install -g npm@11.19.1`.

What it looks like when this is wrong: the run signs a provenance statement,
then dies on

```text
npm error 404 Not Found - PUT https://registry.npmjs.org/dsh-startup-check
```

The publish went out **unauthenticated**; the registry's anonymous answer is a
bare 404 that never mentions authentication. `--loglevel=verbose` is what
finally exposed it, by printing `npm verbose npm v10.9.8`.

### 1. Bootstrap the package locally, once

Trusted publishing can only authenticate a package that **already exists** on
npm, so the first publish comes from a maintainer's machine:

```powershell
pwsh -File scripts\publish-dsh-startup-check.ps1
```

The script walks it interactively: name-availability check, a registry note,
`npm login --auth-type=legacy` (needs your own password and second factor; the
legacy flow talks to the registry instead of opening npmjs.com), a
`npm publish --dry-run` review, the version tag, and the publish behind a typed
`PUBLISH` confirmation. It stops at every stage and stores no credential.

### 2. Create the trusted relationship, **with** the publish permission

```bash
npm trust github dsh-startup-check \
  --file publish.yml \
  --repo cningan/dsh-startup-check \
  --env npm-publish \
  --allow-publish \
  --registry https://registry.npmjs.org/
```

`--allow-publish` is the part that matters. Without it the relationship exists
but carries no permissions, and publishing is refused. Verify what actually
landed on the server — the output must contain a `permissions:` line:

```bash
npm trust list dsh-startup-check --registry https://registry.npmjs.org/
```

```text
type: github
id: …
file: publish.yml
repository: cningan/dsh-startup-check
environment: npm-publish
permissions: publish, stage publish      ← required
```

Two gotchas worth knowing: npm does not validate the configuration when you save
it (its own docs say errors appear only at publish time), and a duplicate
relationship is rejected with `409 Conflict — a trusted publisher configuration
that a token could also match already exists` — delete the old one, then retry.

Then arm the workflow:

```bash
gh variable set NPM_TRUSTED_PUBLISHER_READY --body true --repo cningan/dsh-startup-check
```

### From then on

```bash
npm version patch        # or minor / major — commits and tags
git push --follow-tags   # the v* tag triggers .github/workflows/publish.yml
```

No token is stored anywhere, and the publish carries a provenance attestation
(verify with `npm view dsh-startup-check@<version> dist.attestations`). Until
`NPM_TRUSTED_PUBLISHER_READY` is `true`, a tag still runs the tests but skips
publishing with a notice, instead of failing on every tag.

### If a publish stalls

npm places a **72-hour hold on any account that signs in with a recovery code**,
during which publish and token creation are paused (sign-in, browsing and
installs keep working). It expires on its own; wait it out rather than retrying,
and see
[the npm changelog](https://github.blog/changelog/2026-09-09-npm-extends-recovery-code-security-holds-to-all-accounts/).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
