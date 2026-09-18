# Contributing

Thanks for looking. Bug reports are genuinely useful here: most of this
plugin's defects have been found by someone running it in a real vault, not by
the test suite.

## Reporting a bug

[Open an issue](https://github.com/wilfriedago/obsidian-tinymist/issues/new/choose).
The template asks for the few things that actually narrow a problem down:

- your Obsidian version, operating system, and `tinymist -V`
- what you did and what happened
- the developer console with **Logging** set to `debug` in the plugin settings

Security problems go through [SECURITY.md](SECURITY.md) instead, privately.

## Getting set up

Node 20+ and [pnpm](https://pnpm.io) 10+.

```sh
git clone https://github.com/wilfriedago/obsidian-tinymist
cd obsidian-tinymist
pnpm install
pnpm build
```

You also need Tinymist on your machine — `brew install tinymist`, or see the
README. The integration tests skip themselves without it, so you can work on
most of the plugin either way.

### Running it in Obsidian

`dist/` is the complete plugin folder, so one symlink is enough and every
rebuild is picked up:

```sh
mkdir -p test-vault/.obsidian/plugins
ln -sfn "$PWD/dist" test-vault/.obsidian/plugins/tinymist
pnpm dev                      # rebuilds on change
```

Open `test-vault/` as a vault and enable **Tinymist** under **Settings →
Community plugins**. Reload Obsidian with **Ctrl/Cmd+R** to pick up a rebuild.

**Never develop against a vault you care about.** `test-vault/` exists for
this, with fixtures covering valid and broken documents, multi-file imports, a
real project with a `typst.toml`, and a PDF that predates the plugin.

## The commands

```sh
pnpm dev               # watch build
pnpm build             # typecheck, then production build into dist/
pnpm typecheck
pnpm lint              # oxlint, including 23 Obsidian review rules
pnpm lint:obsidian     # the 6 Obsidian rules that need type information
pnpm test              # everything
pnpm test:unit         # no Tinymist needed
pnpm test:integration  # drives a real Tinymist
pnpm validate:manifest
```

All of these run in CI on Node 20, 22 and 24.

### Why two linters

oxlint is the linter. It runs its own rules plus most of
`eslint-plugin-obsidianmd` through its `jsPlugins` support. Six of those rules
need the TypeScript checker, which oxlint's plugin host does not provide, so a
minimal ESLint config exists for exactly those six and nothing else. If oxlint
gains type-aware plugins, `eslint.config.mts` and the `eslint` dependency can
be deleted outright.

## Where things live

Read [docs/architecture/overview.md](docs/architecture/overview.md) first — it
explains the layering and, more usefully, *why* each boundary is where it is.

| To change | Start in |
| --- | --- |
| A command | `src/plugin/commands.ts` |
| A setting | `src/settings/settings.ts`, then `settings-tab.ts` |
| An editor feature | `src/editor/` |
| The preview | `src/preview/` |
| Anything Tinymist-specific | `src/typst/tinymist/` |
| Anything touching Node | `src/platform/desktop.ts`, and nowhere else |

Two rules worth stating outright:

1. **Only `platform/desktop.ts` may import a Node module.** It currently
   imports exactly one, `node:child_process`, and the plugin's security posture
   depends on that staying true. A filesystem import would give the plugin
   abilities it does not need and would have to be disclosed.
2. **The UI must not know Tinymist is a process.** Views ask a controller for a
   URL or a result; the adapter owns commands, flags, and ports. That boundary
   is what keeps Tinymist upgradable.

## Tests

The suite is in two halves.

**`tests/unit`** needs nothing installed. `obsidian` ships type declarations
only, so `tests/helpers/obsidian-stub.ts` stands in for it.

**`tests/integration`** drives a real `tinymist lsp` and asserts against its
actual responses. It skips itself when no executable is present, unless
`TINYMIST_REQUIRED=1`, which CI sets so a broken install cannot look like a
pass.

These exist because reading Tinymist's source repeatedly proved insufficient.
Its CLI takes kebab-case enum values where the Rust source suggests camelCase;
its export command needs a filesystem path, not a URI; its formatter returns an
edit whose range is *not* the whole document. Each of those was a real bug
found by asking the binary instead of the source.

**If you fix a bug, add the test that would have caught it.** Ideally one that
fails before your change. Several tests in this repo exist precisely because
something shipped broken.

### What tests cannot catch

Anything that only breaks inside a running Obsidian. [docs/testing.md](docs/testing.md)
has a manual checklist — please walk the parts your change touches, and say so
in the pull request.

## Code style

Formatting is whatever the repo already does: tabs, single quotes, and the
existing structure. There is no formatter to run; match the surrounding file.

The one thing reviewers will actually push back on is **comments that restate
the code**. Comments here are for what the code cannot say: why a boundary
exists, which upstream behaviour forced a decision, what breaks if it changes.
For example:

```ts
// Tinymist always writes the exported file to `outputPath`, even when the
// export command is invoked with `{ write: false }` (verified against 0.15.8).
```

That sentence saves the next person an afternoon. `// increment the counter`
does not.

## Pull requests

- Branch from `main`.
- Keep the change focused; unrelated cleanups are much easier to review apart.
- `pnpm lint && pnpm lint:obsidian && pnpm typecheck && pnpm test` before
  pushing. CI runs all of it anyway.
- Write the commit message for someone reading it in a year: what changed, and
  why it was the right call. If you rejected an alternative, say which and why.
- Add a `CHANGELOG.md` entry under a new *Unreleased* heading for anything
  user-visible.

## Branch protection

`main` is protected by a ruleset:

| Rule | Effect |
| --- | --- |
| No force pushes | History on `main` cannot be rewritten |
| No deletion | The branch cannot be deleted |
| Pull request required | Contributors merge through a pull request; no approvals are required, since this is a single-maintainer project |
| Status checks required | `check (20.x)`, `check (22.x)`, `check (24.x)` and `integration` must pass before a merge |

Repository admins bypass the pull-request and status-check rules, so a
maintainer can still push directly. Force-push and deletion protection applies
to everyone, including them — those are the rules that exist to catch mistakes
rather than to enforce process.

Tags are not covered, so the release flow below is unaffected.

## Releases

Maintainers only. A release is a tag; docs-only changes must not create one.

```sh
# 1. bump manifest.json, package.json and versions.json to the same x.y.z
pnpm validate:manifest
# 2. commit, then tag with the bare version — no `v` prefix
git tag -a 0.2.0 -m "0.2.0"
git push origin main 0.2.0
```

The tag triggers `.github/workflows/release.yml`, which validates that the tag
matches the manifest, builds, attests the artifacts, and opens a **draft**
release. Publish it once the notes read well. Obsidian installs `main.js`,
`manifest.json` and `styles.css` from that release, so it must be published —
not left as a draft — before the directory can see it.

`minAppVersion` changes only when a new Obsidian API genuinely requires it, and
`versions.json` must gain a matching entry.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
