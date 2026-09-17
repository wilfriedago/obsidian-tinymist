# Development vault

A throwaway Obsidian vault used to exercise the plugin. Never point the plugin
at a real vault during development.

## Fixtures

| Path | What it covers |
| --- | --- |
| `basic.typ` | Valid document. The happy path for editing, preview, and export. |
| `errors.typ` | Semantic compile errors. Diagnostics must appear in the editor. |
| `syntax-error.typ` | A parse error, which Typst reports alone. |
| `unformatted.typ` | Messy but valid source. Formatting it returns an edit whose range starts part way in, which is the case that used to delete the file's header. |
| `imports.typ` + `imports/shared.typ` | Multi-file resolution without a `typst.toml`. |
| `project/` | A real project: `typst.toml`, template, bibliography, and an image asset. Exercises per-project root detection. |
| `pdf/existing.pdf` | A PDF that predates the plugin. Opening it must use Obsidian's native PDF viewer. |

## Use

1. Open this folder as a vault in Obsidian.
2. Build the plugin from the repository root, then link `dist/` in as the
   plugin folder:
   ```sh
   pnpm build
   mkdir -p test-vault/.obsidian/plugins
   ln -sfn "$PWD/dist" test-vault/.obsidian/plugins/tinymist
   ```
3. Enable **Tinymist** under **Settings → Community plugins**.
