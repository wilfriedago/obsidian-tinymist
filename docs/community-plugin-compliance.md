# Community plugin compliance

How this plugin meets each published requirement for the Obsidian community
directory, checked against the *Developer policies*, *Submission requirements
for plugins*, *Plugin guidelines*, and the *Manifest* reference as of
2026-09-17.

Most of these are enforced mechanically: 23 `eslint-plugin-obsidianmd` rules run
under oxlint (`pnpm lint`), six type-aware ones under ESLint
(`pnpm lint:obsidian`), and the manifest rules in
`scripts/validate-manifest.mjs`. All three run in CI.

**Status: published.** The plugin is listed in the community directory as
[`tinymist`](https://community.obsidian.md/plugins/tinymist). Everything below
is verified in the code and by the automated checks noted.

The directory's listing appends "This plugin has not been manually reviewed by
Obsidian staff" to the description, which is its standard note for an entry
that passed automated review without a manual pass. The findings from that
automated review, and what was done about each, are in the table below.

---

## Developer policies

### Not allowed

| Requirement | Status | How |
| --- | --- | --- |
| No obfuscated code | ✅ | Plain TypeScript in `src/`; `main.js` is a plain esbuild bundle with a banner pointing at the repository. Minification only. |
| No dynamic ads loaded over the internet | ✅ | The plugin makes no network requests at all. |
| No static ads outside the plugin's own interface | ✅ | None anywhere. |
| No client-side telemetry | ✅ | No analytics, no counters, no identifiers. Logging is local `console` output, off by default. |
| Does not install or update itself or its dependencies | ✅ | The plugin never downloads anything. Tinymist is a user-installed program; `resolveExecutable` only *looks* for one and reports an actionable error when it finds none. There is no auto-update code path. |

### Disclosures

| Item | Applies | Where disclosed |
| --- | --- | --- |
| Payment required | No | — |
| Account required | No | — |
| Network use | **No network use** | README, "Privacy and network use" |
| Access to files outside the vault | **Yes, narrowly** | README, "What the plugin touches" — the Tinymist executable is outside the vault by nature, and Typst's package cache and system fonts are read by Tinymist itself |
| Static ads in the plugin's UI | No | — |
| Server-side telemetry | No | — |
| Closed source | No | MIT, source in the repository |

### Copyright and licensing

| Requirement | Status | How |
| --- | --- | --- |
| Includes a LICENSE file | ✅ | `LICENSE` (MIT) |
| Complies with licenses of code used | ✅ | `THIRD_PARTY_NOTICES.md`. `codemirror-lang-typst` is Apache-2.0 and bundled, with the required notice. Tinymist (Apache-2.0) is **not** bundled and no Tinymist source was copied. |
| Respects Obsidian's trademark | ✅ | "Obsidian" appears in neither the plugin `id` nor `name`. The README states the plugin is unofficial. |
| Not a disallowed fork | ✅ | Written from scratch. Prior plugins were read to understand the design space; no code was taken. |

### Forks

Not a fork of any existing plugin. `docs/architecture/research.md` §3 records
which projects were reviewed and what was learned, and states explicitly that no
code was copied.

---

## Submission requirements for plugins

| Requirement | Status | How |
| --- | --- | --- |
| `fundingUrl` only for genuine funding links | ✅ | Absent from the manifest. |
| Appropriate `minAppVersion` | ✅ | `1.13.0`, the release that introduced the declarative settings API this plugin's settings tab is built on. |
| Description ≤ 250 chars, ends with a period, no emoji, correct capitalization | ✅ | Enforced by `scripts/validate-manifest.mjs` in CI. |
| Description does not start with "This is a plugin" | ✅ | Enforced by the same script. |
| Node/Electron APIs ⇒ `isDesktopOnly: true` | ✅ | The plugin spawns a native executable. `isDesktopOnly: true`, and the validator fails the build if it is ever set to `false`. |
| Command IDs do not repeat the plugin ID | ✅ | IDs are `open-preview`, `toggle-preview`, `export-pdf`, `format-document`, `show-project`, `restart-server`. Obsidian adds the `tinymist:` prefix. |
| All sample code removed | ✅ | No file, class, command, setting, or string from the sample plugin survives. No `MyPlugin`, `SampleSettingTab`, ribbon dice, or sample modal. |

---

## Plugin guidelines

| Guideline | Status | How |
| --- | --- | --- |
| Avoid the global `app` | ✅ | Everything uses `this.app`, passed down from the plugin. An oxlint `no-restricted-globals` rule bans the global. |
| Avoid unnecessary console logging | ✅ | One writer (`shared/logging.ts`), level-gated, default `warn`. `info`/`debug` go to `console.debug`, which the console hides by default. |
| Organize code into folders | ✅ | 24 modules across `plugin/`, `editor/`, `preview/`, `typst/`, `settings/`, `platform/`, `shared/`. |
| Rename placeholder class names | ✅ | No placeholder names remain. |
| Avoid `innerHTML` / `outerHTML` / `insertAdjacentHTML` | ✅ | Not used anywhere. All DOM built with `createDiv`/`createEl`/`createSpan`; all untrusted text set via `textContent`. |
| Clean up resources on unload | ✅ | See the lifecycle audit below. |
| Don't detach leaves in `onunload` | ✅ | `onunload` deliberately leaves workspace leaves alone so the user's layout survives an update. |
| No default hotkeys | ✅ | No command declares one. |
| Correct callback type for commands | ✅ | Commands needing an open Typst document use `checkCallback`, so they are hidden rather than failing. |
| Don't hold references to custom views | ✅ | `registerView` factories return new instances; views are always reached via `getLeavesOfType` with an `instanceof` check. |
| Prefer the Vault API over the Adapter API | ✅ | All vault I/O goes through `Vault`. The adapter is touched once, for `getBasePath()`, which Tinymist needs. |
| Don't iterate all files to find one | ✅ | `getAbstractFileByPath` / `getFileByPath` only. |
| Use `normalizePath()` for user-defined paths | ✅ | Applied to export destinations; `containVaultPath` additionally strips `..` so a setting cannot escape the vault. |
| Use `setHeading()` rather than `<h1>` | ✅ | Headings are declared as `type: 'group'` headings; the plugin builds no heading elements itself. |
| No top-level heading naming the plugin | ✅ | General settings sit at the top with no heading. |
| Settings are searchable | ✅ | The tab implements `getSettingDefinitions()`, so Obsidian indexes every row. `display()` is not used. |
| Popout window compatibility | ✅ | Timers go through `window.*` and DOM through `activeDocument`/`createDiv`, enforced by `obsidianmd/prefer-window-timers` and `prefer-active-doc` with no exemptions. |
| Sentence case in UI text | ✅ | With proper nouns and acronyms capitalized ("Typst", "PDF", "PATH"), per the style guide. `obsidianmd/ui/sentence-case` flags these as warnings; the style guide's rule for acronyms and trademarks takes precedence. |
| No hardcoded styling | ✅ | All styling in `styles.css`, built on Obsidian's CSS variables. No `element.style` assignments. |
| `const`/`let` over `var`, `async`/`await` over chains | ✅ | Enforced by oxlint. |
| Popout window compatibility | ✅ | `activeDocument`/`createDiv` rather than the `document` global, enforced by `obsidianmd/prefer-active-doc` and `prefer-create-el`. |

---

## Resource lifecycle audit

Every resource the plugin acquires, and where it is released.

| Resource | Acquired | Released |
| --- | --- | --- |
| Tinymist child process | `TinymistProcess.start` | `stop()` (handshake → SIGTERM → SIGKILL); `killNow()` from `onunload` |
| LSP pending requests | `TinymistClient.request` | Each has a timeout; `dispose()` rejects all on shutdown or crash |
| LSP notification subscriptions | `bindClient` | `disposeClientSubscriptions` on client loss and on unload |
| Restart timer | `scheduleRestart` | `cancelScheduledRestart` in `stop`, `restart`, `unload` |
| Workspace/vault event handlers | `registerEvent` | Obsidian, on unload |
| Status-bar DOM handler | `registerDomEvent` | Obsidian, on unload |
| Views | `registerView` | Obsidian, on unload |
| `.typ` extension binding | `registerExtensions` | Obsidian, on unload |
| Settings tab | `addSettingTab` | Obsidian, on unload |
| Commands | `addCommand` | Obsidian, on unload |
| CodeMirror `EditorView` | `TypstEditorView.onOpen` | `destroy()` in `onClose` |
| Editor debounce timers | On change/cursor move | `cancelTimers` in `onClose` |
| Preview iframe | `TypstPreviewView.render` | Navigated to `about:blank` and removed in `teardownFrame` |
| Preview server task | `PreviewController.start` | `stop()` from the view's `onClose`; `forgetAll` on unload |
| Open document registrations | `DocumentSession.open` | `close` per document; `closeAll` on unload |
| Diagnostics | `DiagnosticsStore.set` | `clear` on close/delete; `clearAll` on unload |

Verified by test for: graceful stop, SIGTERM escalation to SIGKILL, kill-without-handshake,
crash reported once, in-flight requests rejected on disposal. A full test run
leaves **zero** `tinymist` processes behind.

---

## Manifest

```json
{
  "id": "tinymist",
  "name": "Tinymist",
  "version": "0.1.4",
  "minAppVersion": "1.13.0",
  "description": "Edit, preview, and export Typst documents using the Tinymist language server.",
  "author": "Wilfried Ago",
  "authorUrl": "https://github.com/wilfriedago",
  "isDesktopOnly": true
}
```

- `id` is lowercase letters only, contains no `obsidian`, does not end in
  `plugin`, and is not present in `community-plugins.json` (checked 2026-09-17).
- `name` contains neither "Obsidian" nor "Plugin".
- `description` is 76 characters, starts with an action, ends with a period, and
  has no emoji.
- `version` and `versions.json` are kept in step by `version-bump.mjs` and
  checked by `scripts/validate-manifest.mjs`.

⚠️ **Open question for review:** the name "Tinymist" is the name of the upstream
project this plugin integrates. It is not an Obsidian trademark issue, and the
README states plainly that the plugin is unofficial and unaffiliated, but a
reviewer may still ask for a distinct name, and the upstream authors may have a
view. Tracked as [R1](./risks.md#r1-plugin-name-reuses-an-upstream-project-name).

---

## Automated review findings

The directory's automated review of 0.1.0 (commit `ffde801`) reported the
following. Everything is either fixed in 0.1.1 or is an inherent, disclosed
capability.

| Finding | Status |
| --- | --- |
| **Manifest warning** — `authorUrl` must not point at the plugin's own repository | **Fixed** in 0.1.1: it is now `https://github.com/wilfriedago`. `scripts/validate-manifest.mjs` now fails the build on a repository URL, so it cannot regress. |
| **Release recommendation** — the release has no description | **Fixed**: 0.1.1 ships release notes. |
| **Behaviour warning** — direct filesystem access via Node `fs` | **Eliminated** in 0.1.4. The plugin no longer imports any filesystem module: `node:child_process` is the only Node module in the bundle. `spawn` resolves a bare command through `PATH` itself, and `tinymist probe` validates a configured path better than a permission bit would, so the `stat`/`access` calls had nothing left to do. |
| **Behaviour warning** — shell execution via `child_process` | **Irreducible, and disclosed.** Launching Tinymist is what this plugin is for; the capability cannot be removed without removing the plugin. `spawn` is always called with `shell: false` and an argument array, so nothing from a document, filename, or setting can be interpreted as a command. No shell is ever invoked, and no program other than the configured executable is ever run. |
| **Disclosure** — number of network request calls | **No network requests exist.** The bundle contains no `fetch`, `XMLHttpRequest`, `WebSocket`, or `requestUrl`. The counted patterns are the loopback preview URL, the repository URL in the build banner, link-detection string literals inside the bundled Typst grammar, and the plugin's own `DocumentSession.open()`. Itemized in the README under "Why a scanner reports network calls". |
| **Disclosure** — runtime base64 encode/decode | **Removed** in 0.1.4. `atob` was decoding the PDF bytes Tinymist returns; it is now Node's `Buffer.from(base64, 'base64')`, which is one pass instead of a per-character loop and keeps the pattern out of the bundle entirely. |
| **Disclosure** — malware / obfuscation / network scans not available | Scanner-side; nothing to act on. The source is unminified TypeScript in this repository and the released `main.js` carries a build-provenance attestation. |
| **Source warning** — settings tab does not implement `getSettingDefinitions()` | **Fixed** in 0.1.2: the tab is fully declarative, so its rows appear in Obsidian's settings search. `minAppVersion` is now `1.13.0`. |
| **Source warning** — use `window.setTimeout()` etc. for popout compatibility | **Fixed** in 0.1.2: every timer in the adapter goes through `window.*`, and the lint exemption that hid this was removed rather than widened. |
| **Source recommendation** — `display` is deprecated | **Fixed** in 0.1.2: `display()` is gone. |
| **Source warning** — unnecessary type assertion in the settings tab | **Fixed** in 0.1.3: replaced with a real type guard, so an unknown key is refused rather than written to `data.json`. Settings writes are also normalized through the load-time validation. |
| `main.js` artifact attestation | ✅ Pass |
| `styles.css` artifact attestation | ✅ Pass |
| Vault read via the Obsidian API | ✅ Pass |
| No vulnerable dependencies | ✅ Pass |

## Release process

| Requirement | Status |
| --- | --- |
| `main.js`, `manifest.json`, `styles.css` as release assets | ✅ `.github/workflows/release.yml` uploads them from `dist/` before publishing; each asset lands under its basename, which is what Obsidian downloads |
| Release tag matches `manifest.json` version exactly, no `v` prefix | ✅ release-please tags without a `v` (`include-v-in-tag: false`), and the workflow verifies the tag against the manifest before publishing |
| `main.js` not committed | ✅ In `.gitignore` |
| `versions.json` maintained | ✅ Added to every release pull request by `version-bump.mjs`, checked in CI |
| Semantic versioning | ✅ `x.y.z` enforced by the validator |
| README and LICENSE at the repository root | ✅ |

---

## Ongoing obligations

Publication is not the end of the checklist. These stay true or the entry can
be delisted:

1. **No telemetry, no network requests, no self-updating.** Any change here
   needs a README disclosure first, not afterwards.
2. **Keep `minAppVersion` honest.** It is `1.13.0` because the declarative
   settings API requires it. Raising it again needs a real API reason.
3. **Never change the `id`.** `tinymist` is now permanent; the directory keys
   installs on it.
4. **Re-read the policies before each significant release.** They change, and
   this page is a snapshot of 2026-09-17, refreshed 2026-09-18.
5. **Finish the manual pass** in [testing.md](./testing.md). Every defect found
   since publication came from someone running the plugin, not from the
   automated suite.
