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

Two paths, both already wired up:

**CI, preferred.** The package is set up for
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers): the npm
package's Settings → Trusted Publisher points at this repository, this workflow
file (`publish.yml`) and the `npm-publish` environment. Then a release is just

```bash
npm version patch        # or minor / major — commits and tags
git push --follow-tags   # the v* tag triggers .github/workflows/publish.yml
```

No token is stored anywhere, and the publish carries a provenance attestation.

**Locally, when CI cannot be configured yet.** `scripts/publish-dsh-startup-check.ps1`
walks a maintainer through it interactively: name-availability check, registry
note, `npm login` (which needs the maintainer's own password and 2FA code),
`npm publish --dry-run` review, tag push, and the publish itself behind a typed
confirmation. Run it from the repository root:

```powershell
pwsh -File scripts\publish-dsh-startup-check.ps1
```

One thing to know if publishing ever stalls with every security-sensitive write
rejected: npm places a **72-hour hold on any account that signs in with a
recovery code**, during which publish and token creation are paused (sign-in,
browsing and installs keep working). It expires on its own; wait it out rather
than retrying, and see
[the npm changelog](https://github.blog/changelog/2026-09-09-npm-extends-recovery-code-security-holds-to-all-accounts/).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
