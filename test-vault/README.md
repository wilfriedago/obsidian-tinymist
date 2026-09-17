# Development vault

A throwaway Obsidian vault used to exercise the plugin. Never point the plugin
at a real vault during development.

## Fixtures

| Path | What it covers |
| --- | --- |
| `basic.typ` | Valid document. The happy path for editing, preview, and export. |
| `errors.typ` | Semantic compile errors. Diagnostics must appear in the editor. |
| `syntax-error.typ` | A parse error, which Typst reports alone. |
| `imports.typ` + `imports/shared.typ` | Multi-file resolution without a `typst.toml`. |
| `project/` | A real project: `typst.toml`, template, bibliography, and an image asset. Exercises per-project root detection. |
| `pdf/existing.pdf` | A PDF that predates the plugin. Opening it must use Obsidian's native PDF viewer. |

## Use

1. Open this folder as a vault in Obsidian.
2. Build the plugin from the repository root, then link it in:
   ```sh
   pnpm build
   ln -sf "$PWD/main.js"       test-vault/.obsidian/plugins/tinymist/main.js
   ln -sf "$PWD/manifest.json" test-vault/.obsidian/plugins/tinymist/manifest.json
   ln -sf "$PWD/styles.css"    test-vault/.obsidian/plugins/tinymist/styles.css
   ```
3. Enable **Tinymist** under **Settings → Community plugins**.
