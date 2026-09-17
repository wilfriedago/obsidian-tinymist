# Unresolved technical risks

Open questions and known weak points, with what is currently true and what would
settle each one. Ordered roughly by how much they could cost.

---

## R1. Plugin name reuses an upstream project name

**Severity: high (blocks submission if a reviewer objects)**

The plugin is named `tinymist` / "Tinymist", which is the name of the upstream
project it drives. Obsidian's trademark rule concerns the *Obsidian* mark, which
this does not touch, and the `id` is free in the community directory. But:

- A reviewer may read the name as implying an official relationship.
- The upstream authors have their own interest in the name, and the VS Code
  extension already ships under it.
- If the plugin is ever renamed after release, the `id` **cannot** change —
  Obsidian treats it as a stable key.

**Currently mitigated by:** an explicit unaffiliated statement in the README and
in `THIRD_PARTY_NOTICES.md`.

**Settled by:** asking the Tinymist maintainers for their view, and/or choosing a
distinct name before the first release. `typst-studio` and `typst-workbench` were
both verified free.

---

## R2. Tinymist's command surface is not a stable public API

**Severity: high**

The plugin depends on `tinymist.doStartPreview`, `tinymist.doKillPreview`,
`tinymist.scrollPreview`, `tinymist.exportPdf`, and the
`tinymist/preview/scrollSource` notification. Upstream marks several of these as
*internal* commands, intended for its own VS Code extension. Nothing promises
their names, arguments, or return shapes across versions.

Two flags have already been observed to differ from what the source suggested:
`--refresh-style` takes kebab-case values, and `exportPdf` needs a filesystem
path rather than a URI.

**Currently mitigated by:**

- Every command name and argument shape is confined to
  `typst/tinymist/protocol.ts` and `config.ts`.
- The client checks `executeCommandProvider.commands` before using a command, so
  a removed command degrades to "this build does not provide it" rather than an
  unhandled rejection.
- The integration suite exercises each one against a real binary, so CI catches
  a breaking change rather than users doing so.
- A minimum supported version (0.13.0) is enforced at startup.

**Not yet settled:** there is no upper version bound. A future Tinymist could
break the plugin on a user's machine after an unrelated `brew upgrade`. Worth
adding a tested-up-to version and a warning above it.

---

## R3. Only one plugin can own `.typ`

**Severity: medium**

`registerExtensions(['typ'], …)` is global. If another Typst plugin (Typstian,
for instance) is enabled in the same vault, whichever registers last wins, and
the outcome is confusing rather than announced. Typstian's own README warns about
the same thing from the other side.

**Currently mitigated by:** nothing in code.

**Settled by:** detecting on load that `.typ` is already claimed and showing a
single clear notice naming the conflict. Obsidian does not expose a supported API
for this, so it needs investigation.

---

## R4. Tinymist can panic on unexpected paths

**Severity: medium**

Observed during research:

```
$ tinymist compile /tmp/src.typ pdf/out.pdf
thread 'main' panicked at crates/tinymist-world/src/entry.rs:243:26:
entry path must be a valid virtual path: Escapes
```

A panic in the LSP process is a crash, not an error response.

**Currently mitigated by:** the plugin only ever passes absolute paths that lie
inside the vault; the crash handler restarts with backoff and re-announces open
buffers from editor text, so a panic costs a reconnect rather than data.

**Not yet settled:** whether a `.typ` file that imports something outside the
vault, or a symlinked vault, can reach the same panic. Needs a deliberate
adversarial pass over path handling.

---

## R5. The preview iframe is isolated by origin alone

**Severity: medium**

The preview runs untrusted rendered content in an iframe pointed at
`http://127.0.0.1:<port>`. Isolation rests on the same-origin policy, since a
`sandbox` attribute without `allow-same-origin` would break the frontend's
`sessionStorage` use.

That is a real boundary — the frame cannot reach Obsidian's DOM, APIs, or vault.
But it is a *single* boundary, and Electron's handling of loopback origins is
worth confirming rather than assuming.

**Also unverified:** the preview server binds `127.0.0.1` on an ephemeral port
with no authentication. Any local process can connect to it and read the rendered
document while a preview is open. For a single-user desktop machine this matches
what the VS Code extension does, but it should be stated, and it is a genuine
consideration on shared machines.

**Settled by:** testing the frame's reach inside a real Electron renderer, and
asking upstream whether the data plane can require a token.

---

## R6. `{ write: false }` still writes, and the behaviour is undocumented

**Severity: low, but brittle**

Export depends on two observed behaviours that no documentation promises:
`exportPdf` returns base64 bytes when `write` is false, and it writes to
`outputPath` regardless. The plugin pins `outputPath` to a staging directory to
keep that write harmless.

If a future version stopped returning `data`, export would fail cleanly (the code
raises "returned no PDF data"), but it would fail.

**Settled by:** an upstream question about whether a write-free export is
supported, or switching to reading the staged file from disk.

---

## R7. Unverified inside a running Obsidian

**Severity: high until done**

Everything below the UI is tested against real software: 174 automated tests,
including 13 that drive a real Tinymist 0.15.8. **Nothing in this repository has
been run inside Obsidian yet.** The editor view, preview leaf, status bar,
settings tab, and workspace behaviour are unexercised.

Specific unknowns:

- Whether `TextFileView` + a custom `EditorView` behaves well with Obsidian's
  tab restore, split panes, and popout windows.
- Whether the preview iframe renders and connects inside Electron.
- Whether CodeMirror's search panel conflicts with Obsidian's shortcuts.
- Whether `getViewData`/`setViewData` timing loses keystrokes on fast tab
  switches.

**Settled by:** the manual pass in [testing.md](./testing.md).

---

## R8. Formatting replaced the whole document — fixed, and it was worse than rated

**Severity: was critical, now resolved**

This was filed as "low", on the assumption that Tinymist's formatter returns a
whole-document edit. It does not. It returns a single edit whose range starts at
the first line it wants to change:

```
range: start {line: 2, character: 6} -> end {line: 11, character: 10}
```

Replacing the buffer with that edit's text therefore deleted everything above
the first change — for a Typst document, usually the `#import` and `#show`
header. A user hit this and lost a file's header.

Fixed in 0.1.7: edits are applied as ranged CodeMirror changes, so nothing
outside a range is touched, the selection is mapped through, and the whole
format is one undo step. Overlapping edits are refused rather than applied
partially, and the document is re-checked after the request so a keystroke
arriving mid-flight cannot make the edits land in the wrong place.

**The lesson worth keeping:** the original severity came from reasoning about
what the formatter "should" return instead of asking it. The integration suite
now asserts the range is *not* whole-document, so if that ever changes the test
says so.

---

## R9. No incremental document sync

**Severity: low**

`DocumentSession.change` sends full document text on every debounced change.
Simple and impossible to desynchronize, but on a very large `.typ` file it sends
more bytes than an incremental edit would.

**Settled by:** measuring on a large document before optimizing. Tinymist's
compile cost is expected to dominate.

---

## R10. Settings changes require a restart

**Severity: low, but it is a UX rough edge**

Tinymist reads most of its configuration at initialize time, so changing the
executable path, project strategy, fonts, or formatter restarts the server. The
plugin does this automatically rather than pretending the change applied. On a
large project the restart is visible.

**Settled by:** checking which keys `workspace/didChangeConfiguration` genuinely
applies live, and restarting only for the rest.
