# Tinymist

Edit, preview, and export Typst documents in Obsidian, backed by the
[Tinymist](https://github.com/Myriad-Dreamin/tinymist) language server.

`.typ` files open in a real Typst editor with completion, hover, diagnostics and
formatting; the preview lives in an ordinary Obsidian leaf; and an exported PDF
is an ordinary vault file that opens in Obsidian's own PDF viewer.

> **Status: early. Not yet released, and not yet submitted to the community
> directory.** Everything below the user interface is tested — 174 automated
> tests, 13 of which drive a real Tinymist — but the plugin has not yet been
> exercised inside a running Obsidian. See
> [docs/risks.md](docs/risks.md).

> This is an independent, unofficial integration. It is not affiliated with or
> endorsed by the Tinymist project, the Typst project, or Obsidian.

---

## Requirements

- Obsidian **1.13.0** or newer, on **desktop**. The plugin launches a native
  executable, which Obsidian mobile cannot do, so `isDesktopOnly` is `true`.
- A vault stored on the filesystem.
- **Tinymist 0.13.0 or newer, installed by you.** The plugin never downloads or
  updates it — Obsidian's developer policies do not permit a plugin to install
  or update its own dependencies.

### Installing Tinymist

| Platform | Command |
| --- | --- |
| macOS / Linux (Homebrew) | `brew install tinymist` |
| Any (Cargo) | `cargo install tinymist-cli` |
| Windows (Scoop / winget) | `scoop install tinymist` · `winget install Myriad-Dreamin.tinymist` |
| Manual | [GitHub releases](https://github.com/Myriad-Dreamin/tinymist/releases) |

Check it works:

```sh
tinymist -V     # e.g. "tinymist 0.15.8"
```

If `tinymist` is on your `PATH`, the plugin finds it with no configuration. If
not, set the full path under **Settings → Tinymist → Tinymist executable**.

If you already use the Tinymist VS Code extension, it ships its own binary you
can point at, typically at
`~/.vscode/extensions/myriad-dreamin.tinymist-<version>-<platform>/out/tinymist`.

## Installing the plugin

Not in the community directory yet. To run it from source:

```sh
git clone https://github.com/wilfriedago/obsidian-tinymist
cd obsidian-tinymist
pnpm install
pnpm build

# `dist/` is the complete plugin folder: main.js, manifest.json, styles.css.
cp -r dist /path/to/vault/.obsidian/plugins/tinymist
```

Then enable **Tinymist** under **Settings → Community plugins**.

## Use

Open any `.typ` file. Tinymist starts on first use, and the status bar shows
what it is doing.

The Typst editor's tab header carries a **book** button that opens and closes
the preview, so the common case needs no command. Everything else is in the
command palette.

The preview's own controls float over the top-right of the rendered page:
refresh, open source, and a theme button that steps between following the app,
light, and dark. A theme change restarts that preview, because Tinymist fixes
colour inversion when the preview starts.

| Command | Does |
| --- | --- |
| **Typst: Open preview** | Opens the rendered document beside the source |
| **Typst: Toggle preview** | Opens or closes it |
| **Typst: Export PDF** | Compiles and writes a PDF into the vault |
| **Typst: Format document** | Reformats the source |
| **Typst: Show project root** | Reports which folder the document compiles against |
| **Typst: Restart language server** | Restarts Tinymist |

No default hotkeys are set; bind your own under **Settings → Hotkeys**.

Obsidian's **New note** always creates Markdown, so create a `.typ` file the way
you would any other non-Markdown file.

### The status bar

| Shows | Means |
| --- | --- |
| **Typst: ready** | Running; the document compiles |
| **Typst: compiling** | Working |
| **Typst: 2 errors** | Compile problems; they are underlined in the editor |
| **Typst: disconnected** | Tinymist stopped; select to restart |
| **Typst: unavailable** | It could not start; select for the reason |

## Projects

Typst resolves imports and absolute paths against a *project root*, which is not
necessarily your vault root. With the default **Automatic** strategy the root is
the nearest folder containing a `typst.toml`, and otherwise the document's own
folder:

```
vault/
├── notes/
└── papers/
    └── distributed-systems/
        ├── typst.toml          ← this makes the folder a project
        ├── main.typ            ← root: papers/distributed-systems/
        ├── bibliography.bib
        └── figures/
```

Without a `typst.toml`, `papers/distributed-systems/main.typ` still gets
`papers/distributed-systems/` as its root, so two papers never collide.

The other strategies are **Always the vault root** (one project; `/`-absolute
imports reach anywhere in the vault) and **A folder I choose**.

Changing this restarts Tinymist, because it reads the setting at startup.

## PDF export

Export writes a normal file into your vault, and Obsidian takes it from there.
This plugin **does not** register a PDF view, intercept `.pdf` files, or bundle
a PDF renderer — opening any PDF, exported or not, uses Obsidian's own viewer.

- By default the PDF is written beside its source; set a folder in settings to
  collect them elsewhere.
- With **Replace existing PDFs** off (the default), an existing `name.pdf` is
  never clobbered: the export lands on `name-1.pdf`.
- Intermediate files are staged in the plugin's own folder, never in your notes.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Tinymist executable | empty | Empty means "find `tinymist` on `PATH`" |
| Project root | Automatic | See [Projects](#projects) |
| Preview refresh | As you type | Or on save |
| Preview theme | Follow the app | Light, dark, or follow Obsidian. Each preview can override this from its own toolbar |
| Sync with the editor | on | Cursor ↔ preview navigation |
| Show diagnostics | on | Underline compiler errors |
| Enable the formatter | on | |
| PDF folder | empty | Empty means "beside the document" |
| Replace existing PDFs | off | |
| Use system fonts | on | |
| Logging | Off | Raise to `debug` when reporting a problem |

## Privacy and network use

**The plugin makes no network requests.** There is no telemetry, no analytics,
no accounts, and no remote code or styles are loaded. Once Tinymist is
installed, everything works offline.

### What the plugin touches

**The plugin makes no network requests.** It imports no HTTP client; the
shipped bundle contains no `fetch`, `XMLHttpRequest`, `WebSocket`, or
`requestUrl` call. See [Why a scanner reports network
calls](#why-a-scanner-reports-network-calls) if you are looking at an
automated scan that says otherwise.

**It requires exactly one Node module, and one capability: launching Tinymist.**
`child_process.spawn` starts the executable you configured, and nothing else.
It is always called with `shell: false` and an argument array, so no string
from a document, a filename, or a setting is ever handed to a shell and no part
of it can be read as a command. The plugin runs no shell, and runs no program
other than the one at the path you chose.

**It has no filesystem access outside your vault.** The plugin imports no
filesystem module at all — `node:child_process` is the only Node module in the
bundle. It does not stat, read, write, or delete anything through Node. A
configured path is validated by running `tinymist probe` and reading the exit
code, which proves more than a permission bit would, and a bare `tinymist` is
resolved through `PATH` by the operating system when the process is spawned.

Inside your vault, through Obsidian's Vault API, the plugin:

- reads the `.typ` files you open;
- writes PDFs you explicitly export;
- stores its settings in `.obsidian/plugins/tinymist/data.json`, and stages
  exports in `.obsidian/plugins/tinymist/.staging`.

**What Tinymist itself reads** once launched is Typst's own behaviour, not
something the plugin adds: system fonts, if "Use system fonts" is on, and
Typst's package cache for any `#import` from a package. Tinymist may fetch a
Typst package from the network the first time a document imports one. That is a
Typst feature, outside the plugin's control, and the only path by which
anything here can reach the internet.

The plugin does not scan your filesystem, read unrelated files, collect any
data, or send anything anywhere.

The preview runs a local HTTP server that Tinymist starts, bound to `127.0.0.1`
on an ephemeral port, for as long as a preview tab is open. It is not reachable
from other machines. It has no authentication, so on a shared machine another
local user's process could read a document you are previewing.

### Why a scanner reports network calls

Obsidian's automated review counts network calls by pattern-matching the built
`main.js`. It reports several for this plugin. They are all accounted for, and
none of them is a request to a remote server:

| What the scanner sees | What it actually is |
| --- | --- |
| `http://127.0.0.1:<port>/` | The loopback address of the preview server Tinymist runs on your own machine. This is the preview. |
| `https://github.com/wilfriedago/obsidian-tinymist` | A URL in the build banner comment, pointing at this source repository. Not fetched. |
| `"http://"`, `"https://"` | String literals inside the bundled `codemirror-lang-typst` grammar, which uses them to recognize links while highlighting Typst source. Not fetched. |
| `.open(` | `DocumentSession.open()`, the plugin's own method for telling Tinymist a document was opened. The pattern also matches `XMLHttpRequest.open`, which this plugin does not use. |

You can confirm the absence yourself:

```sh
grep -c 'fetch(\|XMLHttpRequest\|new WebSocket\|requestUrl' main.js   # 0
grep -o 'require("[^"]*")' main.js | sort -u                           # no http module
```

## Limitations

- Desktop only.
- Obsidian's find bar does not reach the Typst editor; CodeMirror's own search
  panel (Ctrl/Cmd+F) is provided instead.
- Markdown features — backlinks, tags, the outline — do not apply to `.typ`.
- Only one plugin can own the `.typ` extension. Do not enable another Typst
  editor plugin in the same vault.
- Changing the executable, project, font, or formatter settings restarts
  Tinymist.
- Formatting replaces the whole buffer, so it loses the selection.

## Contributing

```sh
pnpm install
pnpm dev               # rebuild on change
pnpm lint              # oxlint, including the Obsidian review rules
pnpm lint:obsidian     # the six type-aware Obsidian rules
pnpm typecheck
pnpm test              # integration tests skip if Tinymist is absent
```

- [Architecture](docs/architecture/overview.md)
- [Research behind the design](docs/architecture/research.md)
- [Testing, including the manual pass](docs/testing.md)
- [Community plugin compliance](docs/community-plugin-compliance.md)
- [Open risks](docs/risks.md)

## Licence

MIT — see [LICENSE](LICENSE). Third-party components and attribution are listed
in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Tinymist is Apache-2.0 and
is **not** bundled with or modified by this plugin.
