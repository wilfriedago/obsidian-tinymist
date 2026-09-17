# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [semantic versioning](https://semver.org/) in the `x.y.z`
form Obsidian requires.

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
