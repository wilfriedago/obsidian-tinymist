# Architecture

The shape of the system, and why each boundary is where it is. The evidence
behind these decisions is in [research.md](./research.md).

## The one-sentence version

Obsidian owns the workspace, the vault, and the editor surface; Tinymist owns
Typst. The plugin is the adapter between them, and it is built so Tinymist can
be upgraded or swapped without the Obsidian code noticing.

```
                        Obsidian
                            │
          ┌─────────────────┼─────────────────┐
          │                 │                 │
   TypstEditorView    TypstRuntime     TypstPreviewView
   (TextFileView)     (coordination)      (ItemView)
          │                 │                 │
          └─────────────────┼─────────────────┘
                            │
                  ┌─────────┴─────────┐
                  │                   │
          DocumentSession      PreviewController
          DiagnosticsStore     PdfExporter
                  │                   │
                  └─────────┬─────────┘
                            │
                     TinymistManager        ← the only thing that knows
                            │                 a process exists
                     TinymistClient          ← LSP semantics
                            │
                     TinymistProcess         ← bytes and signals
                            │
                       DesktopHost           ← the only Node/Electron code
                            │
                        tinymist lsp
```

Nothing above `TinymistManager` calls `spawn`, constructs a CLI flag, or knows
a port number. A view asks for a URL; the controller below it deals in commands.

## Layers

| Layer | Modules | Knows about |
| --- | --- | --- |
| Entry | `main.ts` | Composition only — no behaviour |
| Coordination | `plugin/runtime.ts`, `plugin/commands.ts`, `plugin/status-bar.ts` | Obsidian and the subsystems below |
| Editor | `editor/*` | CodeMirror 6, LSP request shapes |
| Preview | `preview/*` | A URL and a task lifetime |
| Domain | `typst/documents`, `typst/diagnostics`, `typst/project`, `typst/compiler` | Vault paths, LSP payloads |
| Adapter | `typst/tinymist/*` | Tinymist's process, protocol, and flags |
| Platform | `platform/desktop.ts` | Node and Electron (one module: `child_process`) |
| Shared | `shared/*` | Nothing above it |

`shared/paths.ts` is pure and takes the vault's base directory as an argument,
which is what lets every path conversion be unit-tested without a live vault.

## Decisions worth explaining

### The `.typ` editor is its own CodeMirror view

`registerEditorExtension()` attaches extensions to Obsidian's **Markdown**
editors, globally, and there is no supported way to scope it to another file
type. A `.typ` file is not Markdown. The supported route is `registerView` +
`registerExtensions` with `TextFileView` as the base, which is how Obsidian's
own non-Markdown editors are built.

This is not "a second editor" in the sense the guidelines warn about: the
CodeMirror packages are build **externals**, so the view is constructed from
Obsidian's own CodeMirror instance. Bundling a second copy would be the actual
mistake, and the build is configured to make it impossible.

The honest costs: Obsidian's find bar does not reach a custom `TextFileView`
(CodeMirror's own search panel is registered instead), and Markdown features
such as backlinks and the outline do not apply to `.typ` files.

### The project root is Tinymist's decision, not ours

Tinymist resolves a document's root as: `rootPath` → workspace roots →
nearest `typst.toml` → the file's own folder. **Workspace roots outrank
`typst.toml`.** Declaring the vault as the workspace root would therefore
flatten every paper in the vault into one project and make every `typst.toml`
inert.

So the default strategy, `auto`, sends **no** root and lets Tinymist discover
per file. `typst/project/project.ts` mirrors the same walk, but only to *report*
the answer in the UI — it never overrides the compiler.

The other strategies exist for the cases where a user genuinely wants them:
`vault` (one project, absolute `/` imports reach anywhere in the vault) and
`custom` (a fixed folder).

### Export round-trips through the plugin

`tinymist.exportPdf` writes to its globally configured `outputPath` even when
called with `{ write: false }`, and `outputPath` cannot be varied per call
without a racy configuration change. So:

1. `outputPath` is pinned once, at initialize, to a plugin-owned staging
   directory under `.obsidian/plugins/tinymist/.staging`.
2. Export asks for the document with `{ write: false }` and takes the returned
   base64 bytes.
3. The plugin writes the real file through `Vault.createBinary` /
   `modifyBinary`.

The vault therefore only ever receives a file the plugin deliberately placed, at
a path the user's settings chose, with the user's overwrite policy applied — and
Obsidian indexes it immediately, so it behaves like any other PDF.

Exports are queued, because the staging path is shared.

### Preview isolation

The preview is an `<iframe>` pointed at Tinymist's loopback server
(`http://127.0.0.1:<port>/`). The frontend derives its own websocket address
from `window.location`, so that single URL wires up both channels.

That origin is not Obsidian's `app://obsidian.md`, so the **same-origin policy
alone** prevents rendered document content from reaching Obsidian's DOM, its
APIs, or the vault. No document-derived markup is ever inserted into Obsidian's
own page; the only text the plugin writes into its own DOM goes through
`textContent`.

There is deliberately **no** `sandbox` attribute. Without `allow-same-origin` the
frame would get an opaque origin, and the preview frontend's `sessionStorage`
access would throw — trading working isolation for a broken preview. Cross-origin
already provides the isolation that matters here.

### The platform layer spawns, and does nothing else

`platform/desktop.ts` imports exactly one Node module, `node:child_process`,
and exposes exactly one capability: spawn a command.

It used to import `node:fs` as well, to check whether a candidate path was an
executable file and to walk `PATH` by hand. Both turned out to be unnecessary.
`spawn` resolves a bare command name through `PATH` itself, on every platform,
and running `tinymist probe` validates the binary far better than a permission
bit does — it confirms the program is actually Tinymist rather than merely
executable. Removing the filesystem import means the plugin cannot read, write,
or delete anything outside Obsidian's Vault API, rather than being trusted not
to.

### Crash handling is a state machine, not a retry loop

`TinymistManager` holds one of `stopped | starting | ready | failed | crashed`.
An unexpected exit fails every in-flight request (so nothing hangs), marks the
state `crashed`, and schedules a restart on a 1s → 2s → 5s → 10s backoff. After
four consecutive crashes it stops trying and leaves the user a status-bar action,
because a binary that dies instantly should not be restarted forever.

`DocumentSession` keeps the text it last sent for each open document, so after a
restart every buffer is re-announced **from the editor's text**, not from disk.
A crash therefore cannot silently discard unsaved edits.

### Shutdown is graceful first, forced second

`stop()` runs the LSP `shutdown`/`exit` handshake, waits, then `SIGTERM`, then
`SIGKILL`. `onunload()` cannot await anything, so it calls `killNow()` and
sends `SIGKILL` directly: an orphaned Tinymist outliving Obsidian is worse than
an ungraceful exit. Both paths are covered by tests.

### Settings are declarative

The settings tab describes its rows through `getSettingDefinitions()` rather
than building DOM in `display()`. Obsidian then renders, persists, validates
and — the reason it matters — *indexes them for settings search*. A tab still
using `display()` is invisible to that search, and the method is deprecated as
of 1.13.0, which is why `minAppVersion` is `1.13.0`.

Settings state lives in `TypstRuntime`, not on `plugin.settings`, so the tab
overrides `getControlValue`/`setControlValue` to point at it. That keeps the
runtime the single owner of both the values and the side effects a change
triggers, such as restarting Tinymist.

## Tooling

- **Package manager:** pnpm. `pnpm-workspace.yaml` lists `esbuild` under
  `onlyBuiltDependencies`, because pnpm 10 blocks install scripts by default and
  esbuild needs its postinstall to place the platform binary.
- **Bundler:** esbuild, producing a single CommonJS bundle at `dist/main.js`.
  The build also copies `manifest.json` and `styles.css` into `dist/`, so that
  directory *is* the installable plugin folder and can be symlinked straight
  into a vault. The CodeMirror, Lezer, `obsidian`, `electron` and Node builtin
  modules are externals.
- **Linting:** oxlint (`pnpm lint`) is the linter. It runs its own correctness
  and suspicious rule sets *and* 23 of the `eslint-plugin-obsidianmd` review
  rules, loaded through oxlint's `jsPlugins` support (which is ESLint v9
  compatible).
  - Six obsidianmd rules call `getParserServices()` and need the type checker,
    which oxlint's JS plugin host does not provide: `prefer-instanceof`,
    `prefer-create-el`, `no-unsupported-api`, `no-view-references-in-plugin`,
    `no-plugin-as-component`, and `prefer-file-manager-trash-file`. A minimal
    ESLint config (`pnpm lint:obsidian`) exists for exactly those six and
    nothing else. Both run in CI. When oxlint gains type-aware JS plugins,
    `eslint.config.mts` and the `eslint` dependency can be deleted.
  - `unicorn/no-array-sort` is off: its fix is `toSorted()`, which is ES2023,
    and the build targets ES2021 to match Obsidian's runtime.
  - `no-new` is off: Obsidian's `Notice` is constructed for its side effect.
  - `ui/sentence-case` is a warning, not an error: it lowercases proper nouns
    and acronyms ("Typst", "PDF", "PATH") that Obsidian's own style guide says
    to capitalize correctly.
- **Tests:** Vitest. `tests/unit` needs nothing installed; `tests/integration`
  drives a real Tinymist and skips itself when none is present, unless
  `TINYMIST_REQUIRED=1`.

## Where to add things

| To add | Start in |
| --- | --- |
| A command | `plugin/commands.ts` |
| A setting | `settings/settings.ts`, then `settings/settings-tab.ts` |
| An LSP feature | `editor/language-features.ts` |
| A Tinymist command or flag | `typst/tinymist/protocol.ts` and `config.ts` |
| Anything touching Node | `platform/desktop.ts`, and nowhere else |
