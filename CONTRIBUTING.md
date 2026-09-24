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

`pnpm install` also enables the repository's git hooks, in `.githooks/`, by
setting `core.hooksPath`. If you already set a hooks path yourself, it is left
alone, and the install says how to opt in. The hooks run the same
commit-subject check as CI (see [Pull requests](#pull-requests)):

| Hook | Checks |
| --- | --- |
| `commit-msg` | The subject of each commit, as it is written. `fixup!`, `squash!` and merge subjects pass, since they never reach `main` as they are |
| `pre-push` | Every subject about to land on `main`, including commits made before the hooks were enabled |

`--no-verify` skips either one once; `git config --unset core.hooksPath` turns
them off.

### Running it in Obsidian

```sh
pnpm dev:hot-reload           # once: installs the live-reload plugin
pnpm dev                      # links the vault, then rebuilds on change
```

Open `test-vault/` as a vault and enable both **Tinymist** and **Hot Reload**
under **Settings → Community plugins**. From then on, saving a source file
rebuilds it and Obsidian reloads the plugin on its own — no **Ctrl/Cmd+R**.

`pnpm dev` runs `pnpm dev:setup` first, which is idempotent and does three
things a live reload needs, each of which fails silently when it is missing:

- symlinks `test-vault/.obsidian/plugins/tinymist` → `dist/`, which is the
  complete plugin folder the build produces. It replaces the empty directory a
  fresh clone has there — worth knowing, because `ln -s dist …` against an
  existing directory puts the link *inside* it and nothing appears to be wrong.
- writes `dist/.hotreload`, the marker [Hot Reload](https://github.com/pjeby/hot-reload)
  looks for to decide a plugin is under development.
- seeds `dist/data.json` with `logLevel: debug`, so the console is worth
  opening. Only when there is no `data.json` yet, so a setting changed in the
  app is never overwritten.

Hot Reload is a third-party plugin and is not in the community directory, which
is why it needs a script rather than an in-app install. It is the only command
here that touches the network, and it writes nothing outside `test-vault/`.

Two things to expect from a reload, both specific to this plugin:

- The Tinymist process is killed and respawned, so an open preview restarts and
  the first compile after a reload is a cold one.
- esbuild does not typecheck. Run `pnpm dev:check` in a second terminal, or a
  type error will reach the vault as a runtime failure instead of a build one.

**Never develop against a vault you care about.** `test-vault/` exists for
this, with fixtures covering valid and broken documents, multi-file imports, a
real project with a `typst.toml`, and a PDF that predates the plugin.

## The commands

```sh
pnpm dev               # link the dev vault, then watch build
pnpm dev:setup         # just the vault wiring, without the watch
pnpm dev:hot-reload    # install the live-reload plugin into test-vault/
pnpm dev:check         # typecheck in watch mode; esbuild does not typecheck
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

## Picking something up

[ROADMAP.md](ROADMAP.md) lists what is planned and what is deliberately not,
with the open question that blocks each item. If you want to work on something
there, say so in an issue first — several entries are waiting on an answer
rather than on code, and the answer may change the shape of the work.

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
- Title the pull request in [Conventional Commits](https://www.conventionalcommits.org/)
  form: `feat: …`, `fix: …`, `docs: …`, with `!` after the type for a breaking
  change. Pull requests are squash-merged, so the title becomes the commit on
  `main`, and releases are worked out from those commits. The
  **Conventional Commits** check says whether a title will be understood.
- Add a `CHANGELOG.md` entry under an *Unreleased* heading for anything
  user-visible, written for users rather than reviewers. It becomes the release
  notes. Without one, the release lists pull request titles instead.

## Branch protection

`main` is protected by a ruleset:

| Rule | Effect |
| --- | --- |
| No force pushes | History on `main` cannot be rewritten |
| No deletion | The branch cannot be deleted |
| Pull request required | Contributors merge through a pull request; no approvals are required, since this is a single-maintainer project |
| Status checks required | `ci` must pass before a merge. It is the one check that always reports, and it fails if any matrix or integration job did |

Repository admins bypass the pull-request and status-check rules, so a
maintainer can still push directly. Force-push and deletion protection applies
to everyone, including them — those are the rules that exist to catch mistakes
rather than to enforce process.

Tags are not covered by these rules. Release tags are created by the release
workflow below.

## Releases

Releases are automated by [release-please](https://github.com/googleapis/release-please)
and `.github/workflows/release.yml`, and follow from the commit subjects on
`main`:

| Subjects since the last release | Next version |
| --- | --- |
| Any `feat:` | minor, `0.4.0` → `0.5.0` |
| Otherwise any `fix:`, `perf:` or `revert:` | patch, `0.4.0` → `0.4.1` |
| A `!`, or a `BREAKING CHANGE:` footer | minor while below 1.0 |
| Only `docs:`, `test:`, `ci:`, `chore:` … | no release |

1. After every push to `main`, the workflow keeps one pull request open, titled
   `chore: release x.y.z`. It bumps `package.json`, `manifest.json` and
   `versions.json`, and turns *Unreleased* in `CHANGELOG.md` into the new
   version's section.
2. CI runs on it like on any other pull request. The workflow starts that run
   itself, since GitHub does not run workflows for a pull request the workflow
   opened.
3. **Merging it is the release.** The workflow tags `x.y.z` (bare, no `v`),
   builds, attests, attaches `main.js`, `manifest.json` and `styles.css`, and
   publishes, with that changelog section as the notes.

To change the notes, edit *Unreleased* on `main`. The release branch is
regenerated every time `main` moves, so edits made there do not last. To cut
1.0, add `Release-As: 1.0.0` as a footer on a commit to `main`.

If publishing fails after the tag exists, run the **Release** workflow by hand
with that tag. It rebuilds and re-uploads without creating anything new.

Direct pushes to `main` count too, so their subjects need the same form. The
**Conventional Commits** check flags any that do not, but only after the push.

`minAppVersion` changes only when a new Obsidian API genuinely requires it. Change
it in `manifest.json` in an ordinary pull request; `versions.json` follows at
the next release.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
