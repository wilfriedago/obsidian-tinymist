# Testing

## What runs automatically

```sh
pnpm test              # everything
pnpm test:unit         # no Tinymist needed
pnpm test:integration  # drives a real Tinymist
```

**174 tests across 12 files.**

### Unit tests — `tests/unit`

Need nothing installed. `obsidian` ships type declarations only, so a small
stand-in in `tests/helpers/obsidian-stub.ts` is aliased in for the units that
touch the app.

| File | Covers |
| --- | --- |
| `paths.test.ts` | Vault ↔ absolute ↔ `file:` URI conversion, Windows drive letters, non-ASCII and spaces, and that `..` cannot escape the vault |
| `protocol.test.ts` | `Content-Length` framing: split chunks, several messages per chunk, a cut inside a multi-byte character, malformed headers and bodies |
| `tinymist-config.test.ts` | Executable resolution order, initialization options, and preview argument construction |
| `project.test.ts` | Project root detection across all three strategies, nested manifests, and sibling projects |
| `settings.test.ts` | Migration, type validation, and rejection of out-of-range values |
| `client.test.ts` | Request/response correlation, out-of-order replies, timeouts, server-to-client requests, capability reporting, disposal |
| `process.test.ts` | Spawn failure, stream reassembly, crash vs. requested exit, SIGTERM → SIGKILL escalation, kill-without-handshake |
| `version.test.ts` | Version parsing including the empty-version build, and the minimum-version check |
| `diagnostics.test.ts` | LSP → CodeMirror position mapping, clamping stale positions, severity mapping, the diagnostics store |
| `session.test.ts` | Document identity, version counters, rename, and replay after a restart |
| `preview-and-status.test.ts` | Task ids, preview lifecycle, status-bar wording, snippet and hover conversion |

### Integration tests — `tests/integration`

Drive a **real** `tinymist lsp` and assert against its actual responses. They
skip themselves when no executable is on `PATH`, unless `TINYMIST_REQUIRED=1`,
which CI sets so a broken install cannot masquerade as a pass. The first test in
the file prints the detected versions for the same reason.

Verified against Tinymist 0.15.8 / Typst 0.15.1:

- version detection, initialize handshake, capability and command advertisement
- diagnostics published for a broken document
- a clean compile reported through `compileStatus` and **not** through an empty
  diagnostics array
- completion, hover, document symbols, formatting
- PDF export returning real `%PDF-` bytes, staged outside the vault
- a `file:` URI rejected as the export entry — pinned as an expected failure, so
  the plugin can never regress to passing one
- a preview server started, answering HTTP 200 on loopback, and killed
- a clean restart

These exist because reading Tinymist's source was **not** sufficient: three of
the plugin's assumptions were wrong until a real binary corrected them (see
[research.md](./architecture/research.md)).

### Fixtures — `test-vault/`

A throwaway vault. Never point the plugin at a real one during development.

| Path | Covers |
| --- | --- |
| `basic.typ` | Valid document; the happy path |
| `errors.typ` | Semantic errors; diagnostics must appear |
| `syntax-error.typ` | A parse error, which Typst reports alone |
| `imports.typ`, `imports/shared.typ` | Multi-file resolution with no `typst.toml` |
| `project/` | `typst.toml`, template, bibliography, image asset — per-project root detection |
| `hayagriva/` | A document citing a Hayagriva `.yml` bibliography |
| `pdf/existing.pdf` | A PDF predating the plugin; must open in Obsidian's own viewer |

Each fixture's behaviour was confirmed with the real compiler.

---

## The manual pass

Automated tests cannot exercise Obsidian's UI. **None of this has been done
yet** — it is the gate before a release, and the reason
[R7](./risks.md#r7-unverified-inside-a-running-obsidian) is open.

### Setup

```sh
pnpm install
pnpm build

# `dist/` is the whole plugin folder, so one symlink is enough and every
# rebuild is picked up without re-copying anything.
mkdir -p test-vault/.obsidian/plugins
ln -sfn "$PWD/dist" test-vault/.obsidian/plugins/tinymist
```

Open `test-vault/` as a vault, then enable **Tinymist** under
**Settings → Community plugins**. `pnpm dev` rebuilds on change; reload Obsidian
with **Ctrl/Cmd+R** to pick it up.

### Checklist

Each line is pass/fail, with the acceptance criterion it comes from.

**Creating**

- [ ] Right-clicking a folder in the file explorer offers **New Typst file**, next to **New note**.
- [ ] It creates `Untitled.typ` in that folder and opens it in the Typst editor, with `Untitled` selected in the tab title.
- [ ] Typing a name and pressing Enter renames the file and puts the caret in the editor; Escape keeps `Untitled` and does the same.
- [ ] With **Appearance → Show tab title bar** off, creating a file opens Obsidian's rename dialog instead.
- [ ] An existing `.typ` or `.bib` can be renamed by clicking its tab title, and the preview follows the new name.
- [ ] Doing it again creates `Untitled 1.typ` rather than failing.
- [ ] **Typst: Create new Typst file** puts the file where the "Default location for new notes" setting points.
- [ ] The same menu offers **New BibLaTeX file**, which creates `Untitled.bib` and opens it in the bibliography editor.
- [ ] **Typst: Create new BibLaTeX file** is offered in the command palette.
- [ ] With another plugin that registers `.bib` enabled first, the plugin still loads, `.typ` still opens, and neither the menu entry nor the command is offered.

**Editing**

- [ ] Clicking `basic.typ` in the file explorer opens the Typst editor, not a Markdown view.
- [ ] Typst syntax is highlighted.
- [ ] The status bar reaches **Typst: ready**.
- [ ] Opening `errors.typ` underlines the error and the status bar shows the count.
- [ ] Hovering the underline shows the compiler message.
- [ ] Fixing the error clears the underline.
- [ ] Typing `#fig` offers completions from Tinymist.
- [ ] Hovering a built-in function shows its signature.
- [ ] **Typst: Format document** reformats the buffer.
- [ ] Formatting `unformatted.typ` keeps its `#import` line. (A partial-range edit used to delete everything above the first change.)
- [ ] Undo after formatting restores the document in one step.
- [ ] Selecting text is readable in dark mode, and tinted with the theme's accent colour in both modes.
- [ ] Edits persist: switch tabs and back, then reopen the vault.
- [ ] Ctrl/Cmd+F opens CodeMirror's search panel (Obsidian's own find bar does not reach this view — expected).

**Preview**

- [ ] With source and preview tabs open, append text from an external editor twice. Both tabs update without typing in Obsidian.
- [ ] After those external edits, press Undo, then type and save. Both additions remain on disk.
- [ ] The **book** button in the Typst editor's tab header opens the preview in a split.
- [ ] Pressing it again closes the preview.
- [ ] The **eye** button shows the preview in the editor's own tab instead, and the preview's **Open source** button goes back.
- [ ] **Typst: Open preview** opens a preview in a split, as a normal leaf.
- [ ] **Typst: Open preview in this tab** does the same as the eye button.
- [ ] The document renders.
- [ ] Typing updates the preview without saving.
- [ ] The preview leaf can be moved, split, and resized like any other.
- [ ] Closing the preview tab stops its server (`pgrep -f "tinymist"`).
- [ ] Reopening it works.
- [ ] Moving the cursor scrolls the preview to match.
- [ ] Clicking rendered content moves the cursor in the source.
- [ ] After a preview click, the preview does **not** scroll again on its own (no sync loop).
- [ ] Moving the caret afterwards still scrolls the preview, so suppression is not sticky.
- [ ] In dark mode the page follows the theme.
- [ ] The preview toolbar floats over the top-right of the page and dims when the pointer is elsewhere.
- [ ] The theme button steps follow-the-app → light → dark → follow-the-app, and the page changes each time.
- [ ] Two previews can hold different themes at once.
- [ ] A preview's theme survives closing and reopening the vault.
- [ ] Two `.typ` files can be previewed at once, each showing its own document.

_Following the active document_

- [ ] With a preview open, switching to another `.typ` file re-points it, and the tab header renames to match.
- [ ] Switching to a Markdown note or clicking into the preview leaves it showing the last Typst document.
- [ ] The **pin** button holds the preview on its document while you switch files, and is coloured while pinned.
- [ ] Unpinning does not retarget on its own; the next document switch does.
- [ ] A pinned preview survives closing and reopening the vault.
- [ ] Turning **Follow the active document** off makes the *next* preview start pinned, and leaves open ones as they are.
- [ ] Pin one preview and let another follow, both on the same document: moving the follower off it leaves the pinned one rendering (`pgrep -f "tinymist"` still shows its server).
- [ ] Switching documents ten times leaves one preview server behind, not ten.
- [ ] Switching away *while a preview is still starting* also leaves one: flip between two documents as fast as the status line will let you, then count with `pgrep -f "tinymist"`.

**Projects**

- [ ] `project/main.typ` compiles: the template, bibliography, and `assets/diagram.svg` all resolve.
- [ ] `project/bibliography.bib` shows in the file explorer and opens in the bibliography editor, with the book icon in its tab.
- [ ] With `main.typ` previewed beside it, adding an entry to the `.bib` and citing it updates the preview before the `.bib` is saved.
- [ ] Deleting a closing brace in the `.bib` underlines the error in the `.bib`; restoring it clears the underline.
- [ ] Renaming the `.bib` while it is open keeps the preview compiling once `main.typ` points at the new name.
- [ ] With **Open YAML files as Hayagriva bibliographies** off, `hayagriva/references.yml` does not open in the plugin, and **New Hayagriva file** is not offered.
- [ ] Turning it on makes `references.yml` open in the bibliography editor straight away, without a restart, and offers **New Hayagriva file**, which creates `Untitled.yml`.
- [ ] With `hayagriva/main.typ` previewed, citing a key added to the unsaved `references.yml` updates the preview.
- [ ] **Typst: Show project root** reports `project (typst.toml)`.
- [ ] For `basic.typ` it reports the file's own folder.
- [ ] Setting the strategy to "Always the vault root" changes the answer and restarts the server.

**PDF — the conflict check**

- [ ] **Typst: Export PDF** writes `basic.pdf` next to the source.
- [ ] It appears in the file explorer immediately.
- [ ] Clicking it opens **Obsidian's own PDF viewer**.
- [ ] Exporting again with "Replace existing PDFs" off writes `basic-1.pdf`.
- [ ] With it on, the existing PDF is replaced.
- [ ] Setting a PDF folder writes there instead, creating the folder.
- [ ] **Opening `pdf/existing.pdf` uses Obsidian's native viewer and does not involve this plugin at all.**

**Failure and recovery**

- [ ] With a bad executable path set, the status bar shows **Typst: unavailable** and clicking it explains why.
- [ ] Clearing the path recovers via PATH.
- [ ] `pkill -f "tinymist lsp"` → the status bar shows **Typst: disconnected**, the plugin restarts it, and editing resumes.
- [ ] Unsaved edits survive that restart.
- [ ] **Typst: Restart language server** works from the palette and from settings.

**Shutdown**

- [ ] Disabling the plugin leaves no `tinymist` process (`pgrep -f tinymist`).
- [ ] No leftover views or console errors.
- [ ] Re-enabling works.
- [ ] Quitting Obsidian with a preview open leaves no process behind.

**Workspace**

- [ ] A `.typ` editor and its preview both restore after restarting Obsidian.
- [ ] Popping a Typst editor out into its own window works.
- [ ] Three `.typ` files open at once stay independent.

### External editing limits

Keep the source tab open when editing externally; preview-only reloads are not covered by this fix. Avoid simultaneous writes from Obsidian and another editor. Obsidian's save path does not provide an atomic check against disk changes.

External reloads do not enter undo history. Recover unwanted external changes from version control or backups. Cursor and history mapping preserve unchanged text outside the replaced span; multiple separated edits are treated as one span. Reloads during IME composition have not been verified.

### Before reporting a problem

Set **Logging** to `debug` in the plugin settings, reproduce, then read the
developer console (**Ctrl/Cmd+Shift+I**). Plugin lines are prefixed
`[tinymist:…]`. Document contents are never logged.
