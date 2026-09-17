# Phase 0 research

Everything here was established by reading the official sources or by running
the real software, on 2026-09-17. Where a finding contradicts what the source
code suggested, the running binary won and the discrepancy is recorded.

Versions under test:

| Component | Version |
| --- | --- |
| Tinymist | 0.15.8 (Homebrew bottle, `aarch64-apple-darwin`) |
| Typst (inside Tinymist) | 0.15.1 |
| Obsidian API (`obsidian` on npm) | 1.13.1 |
| `codemirror-lang-typst` | 0.6.0 |
| Node | 24.18.0 |

---

## 1. Obsidian plugin foundation

Read from `obsidianmd/obsidian-sample-plugin` at HEAD, plus
`obsidianmd/obsidian-developer-docs`.

The current sample has moved on from what most third-party guides describe:

- Source lives in `src/`, with `src/main.ts` as the entry point. `main.ts` is
  expected to hold lifecycle only, and the repo's own `AGENTS.md` says to split
  anything over ~200–300 lines into modules.
- `package.json` is `"type": "module"`; the build is `esbuild.config.mjs`.
- ESLint uses the flat config in `eslint.config.mts` with
  `eslint-plugin-obsidianmd`, which encodes the review guidelines as lint rules.
- `main.js` is **not** committed; it is a release artifact only.
- CI runs on Node 20/22/24.

### CodeMirror is supplied by the app, not bundled

The sample's esbuild config marks `@codemirror/*` and `@lezer/*` as `external`.
That is not merely a size optimization: Obsidian already loads CodeMirror 6, and
bundling a second copy would produce two incompatible module instances. A plugin
that imports `@codemirror/state` gets **Obsidian's own instance**.

This is what makes a custom editor view viable — see §4.

### Requirements that shape the architecture

From *Developer policies* and *Submission requirements for plugins*:

- A plugin must not "install or update themselves or their dependencies". This
  rules out the plugin downloading or auto-updating Tinymist.
- Node and Electron APIs are desktop-only and require `isDesktopOnly: true`.
- Command IDs must **not** be prefixed with the plugin ID; Obsidian adds it.
- All sample code must be removed before submission.
- `id` may not contain `obsidian` and may not end with `plugin`; `name` may not
  contain "Obsidian" or "Plugin".
- Accessing files outside the vault, and any network use, must be disclosed in
  the README.

### Registry check

`community-plugins.json` (7,729 plugins) contains these Typst-related entries:

| id | name |
| --- | --- |
| `typst` | Typst Renderer |
| `typst-mate` | Typst Mate |
| `typst-pdf-export` | Typst PDF Export |
| `typst-book-preview` | Typster |
| `typstian` | Typstian |
| `omd-to-typst` | Omd2Typst |
| `wypst` | Wypst |

`typst` and `typstian` are taken. `tinymist` is free, and is the id this project
uses. See [the risk register](../risks.md#r1-plugin-name-reuses-an-upstream-project-name).

---

## 2. Tinymist's interface

Read from `Myriad-Dreamin/tinymist` at 0.15.8, and verified against the running
binary. The plugin treats Tinymist as an external program and copies none of its
source.

### Process surface

- `tinymist probe` — a no-op that exits 0. Cheap validity check (~8 ms).
- `tinymist lsp` — the language server, on stdio. This is what the VS Code
  extension runs, with no extra arguments in production.
- `tinymist preview`, `tinymist compile` — CLI equivalents the plugin does
  **not** use, because the LSP exposes both and reusing one process is cheaper.

### Version detection: use `-V`, not `--version`

**Verified against the binary, and it contradicts the obvious reading.**

```
$ tinymist -V
tinymist 0.15.8

$ tinymist --version
tinymist                       <- the version is EMPTY on this build
Build Timestamp:     2026-09-08T09:55:16.000000000Z
Typst Version:       0.15.1
```

`--version` is bound to clap's `long_version`, and the Homebrew bottle was built
without the version string. Parsing `--version` would have produced "no version
detected" on a perfectly good install. The plugin parses `-V`, and reads
`--version` only for the supplementary `Typst Version:` line.

### LSP capabilities, as advertised at runtime

The initialize response advertises 29 `executeCommandProvider.commands`, and
providers for completion, hover, definition, references, document symbols,
formatting, code actions, semantic tokens, inlay hints, folding, and rename.
Diagnostics arrive by `textDocument/publishDiagnostics`.

Commands this plugin relies on, all verified present:

| Command | Use |
| --- | --- |
| `tinymist.doStartPreview` | Start a preview task |
| `tinymist.doKillPreview` | End one |
| `tinymist.scrollPreview` | Source → preview |
| `tinymist.exportPdf` | Compile to PDF |

Notifications the plugin subscribes to:

| Notification | Payload | Use |
| --- | --- | --- |
| `tinymist/compileStatus` | `{status, path, pageCount}` | Status bar |
| `tinymist/preview/scrollSource` | `{filepath, start, end}` | Preview → source |
| `tinymist/preview/dispose` | `{taskId}` | Tear down client state |
| `tinymist/documentOutline` | outline tree | Not consumed yet |

### Diagnostics are published only for documents that have problems

**Verified.** Opening `basic.typ` (clean) and `errors.typ` (broken) produced:

```
tinymist/compileStatus  {status: "compiling",      path: "/basic.typ"}
tinymist/compileStatus  {status: "compileSuccess", path: "/basic.typ",  pageCount: 1}
tinymist/compileStatus  {status: "compileError",   path: "/errors.typ"}
publishDiagnostics      errors.typ  count=1
```

There is **no** empty `publishDiagnostics` for the clean file. A client that
waits for `diagnostics: []` to declare a document healthy waits forever. The
plugin therefore treats "no entry in the store" as "no problems", and reads
success from `compileStatus`.

Note also that `compileStatus.path` is a **root-relative virtual path**
(`/basic.typ`), not an absolute one.

### Export takes a filesystem path, not a URI

**Verified, and this one is a trap.** Passing a `file:` URI as the first
argument to `tinymist.exportPdf` fails with a misleading error:

```
output path is relative: "file:/…/test-vault/file:/…/test-vault/basic"
```

The URI is being used as the *output* path. VS Code passes `document.uri.fsPath`,
a plain filesystem path. The plugin does the same, and a regression test pins the
URI form as an expected failure.

### `{ write: false }` still writes

**Verified.** With `outputPath` configured, `tinymist.exportPdf` writes the file
regardless of the `write` action flag, and additionally returns the bytes as
base64 when `write` is false:

| Arguments | Result |
| --- | --- |
| `[fsPath, {}, {write: true}]` | writes; `data` empty |
| `[fsPath, {}, {write: false}]` | **writes anyway**; `data` = base64 PDF |

`outputPath` is *global server configuration*, not a per-call argument, so it
cannot be varied per export without a racy `didChangeConfiguration`. The plugin's
answer: point `outputPath` at a plugin-owned staging directory once, take the
returned bytes, and write the real file into the vault through Obsidian's Vault
API. That keeps the destination, the overwrite policy, and vault cleanliness
under the plugin's control. `$name` is the entry's basename; `$root` and `$dir`
are also supported.

### The preview CLI uses kebab-case enum values

**Verified, and it contradicts the source.** `RefreshStyle` carries
`clap(name = "onSave")` attributes, but the enclosing derive renames everything
to kebab-case, and the binary rejects the camelCase form:

```
error: invalid value 'onType' for '--refresh-style <REFRESH_STYLE>'
  [possible values: on-save, on-type]
```

Reading the Rust alone would have shipped a preview that never starts.

### The preview is a self-contained loopback server

`tinymist.doStartPreview` returns:

```json
{"dataPlanePort": 51285, "staticServerPort": 51285,
 "staticServerAddr": "127.0.0.1:51285", "isPrimary": true}
```

Both planes share one port when `--data-plane-host` and `--host` are both `:0`.
`GET http://127.0.0.1:<port>/` returns a 2.0 MB `text/html` document. Inspecting
it:

- **No external references.** No `src`/`href` to any `http(s)` origin. Fully
  offline, which is what makes the plugin's offline-first claim hold.
- It derives its own websocket address from `window.location`:
  ```js
  let urlObject = new URL("/", window.location.href);
  urlObject.protocol = urlObject.protocol.replace("http:", "ws:");
  ```
  So pointing an iframe at the static server wires up both channels with no
  string substitution. (The VS Code extension patches a placeholder instead,
  because it loads the HTML through the LSP rather than over HTTP.)
- It uses `sessionStorage`, `fetch`, `XMLHttpRequest` and `WebSocket`.
- Its VS Code bridge is guarded: `typeof acquireVsCodeApi !== "undefined"`, so it
  degrades cleanly outside VS Code.

The `sessionStorage` use is the reason the preview iframe carries **no**
`sandbox` attribute — see [the architecture overview](./overview.md#preview-isolation).

### Project root resolution

`crates/tinymist-project/src/entry.rs` resolves a document's root in this order:

1. the `rootPath` configuration entry;
2. the first LSP **workspace root** that contains the file;
3. the nearest ancestor directory containing a `typst.toml`;
4. the file's own parent directory;
5. the first workspace root, if any.

**Step 2 outranks step 3.** Declaring the vault as the workspace root would
therefore make every `typst.toml` in the vault inert and collapse every paper
into a single project — exactly the outcome to avoid. This single fact decides
the plugin's default: send *no* root and let Tinymist discover per file.

### Tinymist can panic on paths outside the root

**Observed.** Compiling an input outside the implied root while naming a
relative output:

```
$ tinymist compile /tmp/src.typ pdf/out.pdf
thread 'main' panicked at crates/tinymist-world/src/entry.rs:243:26:
entry path must be a valid virtual path: Escapes
```

The plugin only ever passes absolute in-vault paths, and
[the risk register](../risks.md#r4-tinymist-can-panic-on-unexpected-paths)
tracks it.

---

## 3. Existing Obsidian Typst plugins

Reviewed to understand the design space. **No code was copied from any of them.**

**Typstian** (`whitekid/typstian`, MIT) is the closest prior art: it opens `.typ`
in a `TextFileView`, embeds the Typst compiler as WebAssembly, and renders the
preview as a PDF via `pdfjs-dist`. Useful conclusions:

- It confirms `registerExtensions(['typ'], …)` plus `TextFileView` as the
  supported route for a non-Markdown editor.
- Its README warns that two plugins registering `.typ` in one vault conflict —
  a real constraint, recorded as a risk.
- Its source notes that **Obsidian's own find bar never reaches a custom
  `TextFileView`**, which is why this plugin ships CodeMirror's `search`
  extension instead.
- It uses `codemirror-lang-typst` for syntax, which is how this project found
  that package.
- Its WASM approach removes the install step but forgoes language intelligence.
  Using Tinymist is this project's deliberate opposite trade.

**Typst Renderer** (`fenjalien/obsidian-typst`) renders Typst inside Markdown
code blocks. Different product; it owns the `typst` plugin id.

---

## 4. Why a custom editor view, given the guidance to avoid one

`registerEditorExtension()` registers a CodeMirror extension with **Obsidian's
Markdown editors**, globally. There is no supported way to attach it to a
non-Markdown file type, and a `.typ` file is not Markdown: Obsidian's editor is
bound to Markdown parsing and Live Preview throughout.

The supported route for a non-Markdown file type is `registerView` +
`registerExtensions`, with `TextFileView` as the base class — the same shape
Obsidian's own non-Markdown editors use. Because the CodeMirror packages are
externals, the view's `EditorView` is built from Obsidian's own CM6 instance, so
this is not "a second editor" in the sense the guidance warns about.

Consequences, which are honest costs rather than oversights:

- Obsidian's find bar does not reach the view; CodeMirror's own search panel is
  registered in its place.
- Obsidian Markdown features (backlinks, tags, outline) do not apply to `.typ`.

---

## 5. `.typ` and `.pdf` must not be confused

`registerExtensions(['typ'], TYPST_EDITOR_VIEW_TYPE)` claims `.typ` **only**.
Obsidian's core PDF view keeps `.pdf`, so an exported PDF opens in Obsidian's
native viewer like any other PDF in the vault. The plugin registers no PDF view,
intercepts no `.pdf` file, and bundles no PDF renderer.

---

## 6. Sources

- <https://github.com/obsidianmd/obsidian-sample-plugin> (including its `AGENTS.md`)
- <https://github.com/obsidianmd/obsidian-developer-docs>
- <https://github.com/obsidianmd/obsidian-api> (`obsidian.d.ts`)
- <https://github.com/obsidianmd/obsidian-releases> (`community-plugins.json`)
- <https://github.com/Myriad-Dreamin/tinymist> at 0.15.8, notably
  `crates/tinymist/src/server.rs`, `crates/tinymist/src/config.rs`,
  `crates/tinymist/src/tool/preview.rs`,
  `crates/tinymist-project/src/entry.rs`, and `editors/vscode/src/`
- <https://github.com/whitekid/typstian>, <https://github.com/fenjalien/obsidian-typst>
- <https://github.com/kxxt/codemirror-lang-typst>
