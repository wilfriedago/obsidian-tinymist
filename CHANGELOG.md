# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [semantic versioning](https://semver.org/) in the `x.y.z`
form Obsidian requires.

## [Unreleased]

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
- Not yet verified inside a running Obsidian; see `docs/risks.md`.
