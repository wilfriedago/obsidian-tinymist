# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [semantic versioning](https://semver.org/) in the `x.y.z`
form Obsidian requires.

## [Unreleased]

### Added

- **BibLaTeX bibliographies open in Obsidian.** `.bib` files were not
  registered, so Obsidian hid them and could not open them, even though Typst
  read them fine. They now open in a plain editor, and **New BibLaTeX file** is
  offered beside **New Typst file**. An open bibliography is kept in step with
  Tinymist, so a citing document compiles against unsaved edits and a parse
  error is underlined in the bibliography itself. If another plugin already
  opens `.bib` files, it keeps them. Requested in
  [#11](https://github.com/wilfriedago/obsidian-tinymist/issues/11).

## [0.4.0] - 2026-09-22

### Added

- **The preview renders only the pages on screen.** Tinymist supports this and
  the plugin was not asking for it, so every preview sent and drew the whole
  document. On a 316-page document that was 1.1 MB of payload before anything
  appeared. Matches the default in Tinymist's own VS Code extension, and can be
  turned off under **Preview → Render only visible pages** if a document ever
  draws incorrectly.

### Fixed

- External edits now update the preview while the source tab is open, without
  triggering another save. Reloads no longer enter undo history, so Undo cannot
  restore the old document over an external edit. Thanks to
  [@jas-ho](https://github.com/jas-ho) in
  [#10](https://github.com/wilfriedago/obsidian-tinymist/pull/10).

## [0.3.1] - 2026-09-22

### Fixed

- Removed an `await` on `requestSaveLayout`, which is a debouncer rather than a
  promise, so awaiting it did nothing. No behaviour changes: the layout was
  already being saved on Obsidian's own schedule.

## [0.3.0] - 2026-09-22

### Added

- **The preview follows the document you are editing.** Switching to another
  `.typ` file re-points an open preview at it, instead of leaving it showing
  the file it was opened with. Turn it off under **Preview → Follow the active
  document**, which sets what a *new* preview does.
- **A pin, per preview.** The pin in a preview's toolbar holds it on one
  document while you edit others — the counterpart to following, for people
  who keep one main file on screen. The choice is remembered per leaf and
  survives a restart.
- **The preview can take over the editor's tab.** A second button in the
  `.typ` tab header, and the **Typst: Open preview in this tab** command, show
  the preview in place of the editor rather than beside it, which is the only
  way it fits on a narrow window. The preview's **Open source** button goes
  back. A preview of that document that is already open is revealed instead,
  since one Tinymist task serves one document.

### Fixed

- A preview that changed document left the previous one's Tinymist server
  running. Re-pointing now releases the old task, and a task is only stopped
  once no preview is showing it — so two previews on the same document no
  longer take each other's server down.
- A preview's theme choice is now written to the workspace when it is made,
  rather than whenever Obsidian next happened to save the layout.

Reported in [#7](https://github.com/wilfriedago/obsidian-tinymist/issues/7).

## [0.2.1] - 2026-09-18

### Fixed

- The preview no longer reloads itself when nothing about it changed. Obsidian
  can call `onOpen` and `setState` in either order and both trigger a render,
  so the frame was being torn down and rebuilt against the same URL —
  re-downloading the preview frontend and re-initializing its WebAssembly for
  nothing. Renders are now serialized and skipped when the URL is unchanged.
- Switching the preview theme now says **Reloading…** while it happens, instead
  of going blank without explanation.

## [0.2.0] - 2026-09-18

### Added

- **Create a Typst file from the file explorer.** Right-click a folder and
  choose **New Typst file**, or run **Typst: Create new Typst file**, which
  puts it wherever your "Default location for new notes" setting points.
  Obsidian's own **New note** always makes Markdown and its dropdown cannot be
  extended, so until now a `.typ` file had to be created some other way.

## [0.1.7] - 2026-09-18

### Fixed

- **Formatting no longer destroys the top of the file.** Tinymist's formatter
  returns a single edit whose range starts at the first line it wants to
  change, not at the start of the document. The plugin treated that edit's text
  as the whole formatted document, which deleted everything above it — for a
  Typst file, usually the `#import` and `#show` header.

  Edits are now applied as ranged changes, so nothing outside a range is
  touched, the caret is mapped through, and a format is a single undo step.
  Overlapping edits are refused rather than partially applied, and the document
  is re-checked after the request so a keystroke arriving mid-flight cannot make
  the edits land in the wrong place.

- **Selected text is readable in dark mode.** CodeMirror's base theme styles the
  focused selection five classes deep and hard-codes a pale lavender, and it
  picks light-vs-dark from its own flag rather than Obsidian's — so in a dark
  vault that lavender sat behind light text. The plugin's rules now match that
  specificity and derive the colour from Obsidian's accent, at an alpha that
  tints rather than covers, in both light and dark mode.

  `--tinymist-selection` is exposed for themes and snippets to override.

## [0.1.6] - 2026-09-18

### Fixed

- **Clicking the preview now moves the cursor.** Tinymist only sends
  `tinymist/preview/scrollSource` when the client sets
  `customizedShowDocument`; otherwise it sends a standard
  `window/showDocument` request instead. The plugin set neither, so it handled
  a notification that was never sent and answered the request with "method not
  found". It now sets the option *and* handles the standard request, so the
  jump works either way.
- **Source and preview no longer echo each other.** Answering a preview click
  moved the cursor, the cursor move was reported back to the preview, and the
  preview scrolled again. The selection change the plugin makes is now marked
  as its own, so only the user's caret moves reach the preview.

### Changed

- Removed a redundant type assertion in the PDF decoder, and pinned the
  pooled-buffer behaviour it relies on with tests: Node allocates small buffers
  from a shared pool, so the exact byte range has to be copied out rather than
  the whole backing store handed to the vault.

## [0.1.5] - 2026-09-17

### Fixed

- **Tinymist is found automatically again.** An app launched from Finder, the
  Dock, or a desktop shortcut does not inherit the shell's `PATH`; on macOS it
  gets `/usr/bin:/bin:/usr/sbin:/sbin`, which does not include Homebrew's
  `/opt/homebrew/bin`. A `tinymist` that worked in a terminal was therefore
  invisible to the plugin, and had to be configured by hand.

  The plugin now also searches the directories package managers install into
  (Homebrew, MacPorts, Cargo, `~/.local/bin`, Snap, Flatpak, scoop, winget).
  They are appended, so anything already on `PATH` keeps priority, and no shell
  is run to discover them.

- The "not found" message now names this cause instead of implying Tinymist is
  not installed, and reports the `PATH` that was searched.

## [0.1.4] - 2026-09-17

### Removed

- **All filesystem access.** The plugin no longer imports any Node filesystem
  module; `node:child_process` is the only Node module in the bundle. The
  `stat`/`access` checks and the hand-written `PATH` walk are gone: `spawn`
  resolves a bare command through `PATH` itself, and `tinymist probe` validates
  a configured path better than a permission bit does, because it confirms the
  program really is Tinymist. This also fixes executable lookup on Windows,
  where the old code had to special-case `PATHEXT`.
- **Runtime base64 calls.** `atob` is replaced by `Buffer.from(base64,
  'base64')`, which decodes in one pass instead of a per-character loop.

### Changed

- A failed startup now distinguishes "no such file", "exists but could not be
  run", and "ran but failed", so the message says what to do about it.

## [0.1.3] - 2026-09-17

### Changed

- Settings keys arriving from Obsidian's settings framework are now narrowed
  with a type guard instead of an assertion. An unrecognized key is refused
  rather than written into `data.json`, and because the guard checks *own*
  properties it is not fooled by `toString`, `constructor`, or `__proto__`.
- Settings writes are normalized through the same validation that guards
  `loadData`, so a bad value cannot reach storage at all rather than being
  corrected on the next load.

## [0.1.2] - 2026-09-17

### Changed

- **The settings tab is now declarative.** It implements
  `getSettingDefinitions()` instead of `display()`, so every setting appears in
  Obsidian's settings search. Values are still owned by the plugin runtime, via
  the `getControlValue`/`setControlValue` hooks that exist for exactly that.
- **`minAppVersion` is now `1.13.0`**, which the declarative settings API
  requires. The plugin had no released user base on older versions, so the
  migration guide's preferred path applied.
- **Timers go through `window`.** Every `setTimeout`/`setInterval` in the
  Tinymist adapter now uses `window.*`, for popout window compatibility. The
  lint exemption that had been hiding this was removed rather than widened; the
  Node test host supplies a `window` instead.

## [0.1.1] - 2026-09-17

### Fixed

- `authorUrl` now points at the author's profile rather than the plugin's own
  repository, as the community directory requires. `validate:manifest` fails
  the build on a repository URL so it cannot regress.

### Changed

- Narrowed the plugin's filesystem surface. The unused temporary-directory
  helpers were removed from the platform layer, leaving only the `stat` and
  `access` metadata checks needed to validate the Tinymist executable. The
  plugin now has no ability to read file contents, or to write or delete
  anything, outside Obsidian's Vault API.
- The README now states precisely what the plugin does outside the vault, and
  why: one `spawn` of the configured executable, never through a shell, and
  read-only metadata checks.

## [0.1.0] - 2026-09-17

### Added

- Typst source editor for `.typ` files, built on Obsidian's own CodeMirror 6
  instance, with syntax highlighting, diagnostics, completion, hover, search,
  folding, and bracket matching.
- Tinymist adapter: executable resolution, version detection, process
  lifecycle, LSP client, crash detection with backed-off restart, and graceful
  shutdown that escalates to a forced kill.
- Typst preview as an Obsidian workspace leaf, rendered by Tinymist's own
  preview server in an isolated loopback iframe, reachable from a button in the
  editor's tab header as well as from the command palette.
- Source ↔ preview synchronisation in both directions, using Tinymist's
  existing span mapping.
- PDF export into the vault through Obsidian's Vault API, with a configurable
  destination and a non-clobbering default.
- Project root detection mirroring Tinymist's own resolver, with automatic,
  vault, and custom strategies.
- Per-preview theme control: follow the app, light, or dark, from a floating
  toolbar over the rendered page.
- Status-bar indicator for server and compile state.
- Settings tab covering the executable, project strategy, preview behaviour,
  diagnostics, export destination, fonts, and logging.
- Level-gated structured logging that never records document contents.
- 174 tests, 13 of which drive a real Tinymist executable.
- Development vault fixtures under `test-vault/`.

### Notes

- Requires Tinymist 0.13.0 or newer, installed separately.
- Desktop only.
