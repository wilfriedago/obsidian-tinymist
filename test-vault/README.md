# Development vault

A throwaway Obsidian vault used to exercise the plugin. Never point the plugin
at a real vault during development.

## Fixtures

| Path                                 | What it covers                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `basic.typ`                          | Valid document. The happy path for editing, preview, and export.                                                                               |
| `errors.typ`                         | Semantic compile errors. Diagnostics must appear in the editor.                                                                                |
| `syntax-error.typ`                   | A parse error, which Typst reports alone.                                                                                                      |
| `unformatted.typ`                    | Messy but valid source. Formatting it returns an edit whose range starts part way in, which is the case that used to delete the file's header. |
| `imports.typ` + `imports/shared.typ` | Multi-file resolution without a `typst.toml`.                                                                                                  |
| `links.typ`                          | A path of every kind that Mod-click opens: an import, an include, an image, and data read with `read()` and `yaml()`.                          |
| `project/`                           | A real project: `typst.toml`, template, bibliography, and an image asset. Exercises per-project root detection.                                |
| `hayagriva/`                         | A document citing a Hayagriva `.yml` bibliography, for the YAML editor.                                                                        |
| `pdf/existing.pdf`                   | A PDF that predates the plugin. Opening it must use Obsidian's native PDF viewer.                                                              |

## Use

From the repository root:

```sh
pnpm dev:hot-reload   # once
pnpm dev
```

Then open this folder as a vault and enable **Tinymist** and **Hot Reload**
under **Settings → Community plugins**. Saving a source file rebuilds and
reloads the plugin without a restart.

See [CONTRIBUTING.md](../CONTRIBUTING.md#running-it-in-obsidian) for what that
wires up and what a reload does to the Tinymist process.
