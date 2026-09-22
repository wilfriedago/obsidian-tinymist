# Roadmap

What is being considered, what is not, and why. There are no dates here —
this is a spare-time project, and a date would be a guess dressed up as a
commitment. Items move when someone does the work.

**How to read this**

| | |
| --- | --- |
| **Next** | Decided, and the design is clear enough to start |
| **Considering** | Wanted, but a question needs answering first — usually "does Tinymist already do this?" |
| **Not planned** | Deliberately out of scope, with the reason |

Where an entry says **verified**, the mechanism was exercised against a real
Tinymist and the observed output is quoted. That distinction matters: several
items below look like features to build and are really features to *surface*.

The guiding rule is the one the plugin was built on: **Tinymist owns Typst, the
plugin owns Obsidian.** Anything the language server can already do should be
surfaced rather than reimplemented. That is what keeps the plugin small and
Tinymist upgradable.

If something here matters to you, say so in an
[issue](https://github.com/wilfriedago/obsidian-tinymist/issues) — what people
actually hit moves faster than what looks good on a list.

---

## Next

### Multi-file projects

The largest gap between what the plugin does and how people actually write long
documents. Open `chapter-3.typ` today and Tinymist compiles *that file alone*:
the preview shows a fragment, and diagnostics complain about every definition
that lives in `main.typ`. A thesis is the shape of document this plugin exists
for, and it is the shape that works least well.

Tinymist already solves it. `tinymist.pinMain` tells the server which file is
the document, and everything else compiles as part of it. **Verified**: with
`project/main.typ` pinned, editing `template.typ` — a fragment that cannot
stand alone — produces

```
compileSuccess  /main.typ  pages=1
```

So the engine work is done and this is a user-interface problem:

- a command to set the current file as the project's main document, and to
  clear it
- picking it up automatically from `typst.toml`'s `entrypoint`, which is what
  the fixture project already declares, so most users never set it by hand
- showing which document is pinned, because an invisible mode is worse than no
  mode
- deciding what the preview follows: an unpinned preview follows the active
  editor, and pinning a main document means it should follow that instead,
  while the caret still drives source-to-preview sync from whichever file you
  are editing. The preview's own pin
  ([#7](https://github.com/wilfriedago/obsidian-tinymist/issues/7)) is a
  per-leaf choice and does not decide the project's main file; these two need
  to end up as one idea rather than two.

The open question is scope, not feasibility: whether pinning is per-vault, per
project root, or remembered per document. Per project root is probably right,
since that is the unit Typst itself compiles, but it is worth deciding before
the first line rather than after.

### Word count

Already arriving on every compile, and currently discarded. Tinymist attaches
it to the `tinymist/compileStatus` notification the status bar already
consumes. **Verified**, for `basic.typ`:

```json
{"chars": 407, "cjkChars": 0, "spaces": 60, "words": 61}
```

People writing to a length care about this more than almost anything else the
plugin does, and it is a status-bar segment rather than a feature. Note the
separate `cjkChars`: Tinymist counts CJK characters apart from words, so the
figure is meaningful for Chinese and Japanese rather than quietly wrong.

The only real decision is what to show by default — words, or characters, or
both — and whether it belongs in the status bar or behind a command. The status
bar is already the place the plugin reports document state.

### Spell checking in the editor

Typst's own web editor flags misspelled words inline and offers a popover with
corrections, a personal dictionary, and a note about which language the check
ran in. Writing a thesis in Obsidian without that is a real gap, because
Obsidian's own spell checker does not reach the Typst editor: it works on the
Markdown editor, and this plugin necessarily runs its own CodeMirror instance
(see [the architecture notes](docs/architecture/overview.md#the-typ-editor-is-its-own-codemirror-view)).

What it should do:

- underline misspelled words in prose, and **only** in prose — a Typst document
  is full of identifiers, package names, and code where a squiggle is noise
- offer corrections, "add to dictionary", and "ignore here" from a popover
- follow the document's own `#set text(lang: "..", region: "..")` rather than a
  plugin setting, so a French document is checked in French without extra
  configuration
- persist the personal dictionary in the vault, so it syncs with everything else

Open questions, in the order they need answering:

1. **Does Tinymist already do it?** It ships a linting facility, and if
   spell checking lands there it arrives as diagnostics the plugin already
   renders — which would make this mostly a settings toggle rather than a
   feature. Worth asking upstream before building anything.
2. **Where do the dictionaries come from?** Shipping word lists would add
   megabytes to a plugin that is currently 172 KB, and downloading them at
   runtime is not allowed — Obsidian's policies forbid a plugin installing its
   own dependencies. Using the system spell checker through Electron is the
   promising route, since Obsidian already relies on it, but whether a plugin
   can reach it from a non-Markdown CodeMirror view needs checking.
3. **How is prose told apart from code?** The Typst grammar already parses the
   document, so the syntax tree should be able to answer this. That is the part
   most likely to be fiddly, and the part most likely to make the feature
   annoying if it is wrong.

Nothing starts until (1) is answered, because the answer decides whether this
is a small feature or a large one.

### Document outline

A long Typst document is currently unnavigable, while a Markdown note of the
same length gets an outline for free. Tinymist answers
`textDocument/documentSymbol` and additionally pushes
`tinymist/documentOutline`, which the plugin subscribes to and ignores.

**Verified**: `project/main.typ` returns `Introduction | Bibliography check`.

The open question is where it goes. Obsidian's own outline view is built around
Markdown, and whether a plugin can populate it for a custom file type is
unestablished — so the first step is an hour spent finding out, not a design.
If it cannot, the fallback is a small view of the plugin's own, which is more
work and less native, and worth knowing before choosing.

### A tested-up-to Tinymist version

The plugin enforces a minimum Tinymist version but no maximum, so an unrelated
`brew upgrade` can break it with no warning. It should record the version range
it was tested against and say something useful above it, rather than failing in
an obscure way.

Tracked as [R2](docs/risks.md#r2-tinymists-command-surface-is-not-a-stable-public-api).

### Tell the user when another plugin owns `.typ`

Only one plugin can register a file extension. When two do, the result today is
confusing rather than explained. The plugin should notice and say so plainly.

Tracked as [R3](docs/risks.md#r3-only-one-plugin-can-own-typ).

---

## Considering

### Typst files as first-class vault citizens

The strategically largest item here, and the least certain.

`.typ` files are islands. You cannot link to one from a Markdown note, they do
not appear in the graph, and they have no backlinks. The plugin's claim is that
Typst becomes a first-class document type in Obsidian, and this is the part of
that claim which is not yet true. Everything else on this roadmap makes the
editor better; this is what would make the *vault* whole.

It is listed here rather than under Next because feasibility is genuinely
unknown. Obsidian's link resolution, backlink index, and graph are built around
Markdown, and whether a plugin can contribute a non-Markdown file type to them
is unestablished. The first step is not a design but an hour with
`MetadataCache` and `resolvedLinks` to find out whether it is possible at all.

If it is not, that is worth knowing and writing down, because it bounds what
"first-class" can honestly mean.

### Go to definition, references, and rename

Tinymist answers all three, and the plugin already declares the client
capabilities — the providers are advertised in the initialize response and
nothing consumes them. What is missing is the editor-side wiring: a command, a
keybinding, and somewhere sensible to show references. Rename in particular
wants care, since it edits files that may not be open.

This becomes considerably more valuable once multi-file projects work, and is
probably best done after them rather than before.

### Cross-reference completion

Typing `@` in a Typst document should offer the labels defined across the
project, the way a citation key or a heading reference would in a reference
manager. `tinymist.getWorkspaceLabels` exists for exactly this and is unused.

Worth doing after multi-file projects, since a label index across one file is
not worth much.

### Quick fixes from diagnostics

`codeActionProvider` is advertised and unused. Turning "unknown variable" into
an offer to import the thing is the difference between a diagnostic that tells
you off and one that helps. The plugin already renders diagnostics in
CodeMirror, and CodeMirror's lint panel has a place for actions, so the wiring
is more plumbing than design.

### Settings that apply without a restart

Changing the executable, project strategy, fonts, or formatter restarts
Tinymist today, which is honest but visibly slow on a large project. Some of
those keys may apply live through `workspace/didChangeConfiguration`. Worth
measuring which, rather than assuming.

Tracked as [R10](docs/risks.md#r10-settings-changes-require-a-restart).

### Export beyond PDF

Tinymist exposes PNG, SVG, HTML, Markdown, LaTeX, plain text, and a bundle
format through the same command surface the PDF export already uses — eight
export commands, of which the plugin uses one. The mechanism is proven; the
question is UI. A command per format would turn a tidy palette into a wall of
entries, so a single "Export as…" with a format prompt is more likely right.

Markdown export deserves separate thought: it turns a Typst document into
something the rest of the vault can actually read, which is a different kind of
useful from PNG.

### Incremental document sync

Full document text is sent on every debounced change. Simple and impossible to
desynchronize, but wasteful on a very large file. Worth measuring before
optimizing — Tinymist's compile cost is expected to dominate.

Tracked as [R9](docs/risks.md#r9-no-incremental-document-sync).

### Snippets and templates for a new file

**New Typst file** creates an empty document, deliberately. A separate "new
from template" affordance would be the honest way to offer a starting point
without guessing at one.

Tinymist has `tinymist.doInitTemplate` and `tinymist.doGetTemplateEntry`, which
work against the Typst package registry, so "new from a Typst Universe
template" is available without the plugin managing template files itself. That
is probably a better first version than a vault folder of templates, because it
starts useful rather than empty.

---

## Not planned

### Mobile support

The plugin launches a native executable, which Obsidian mobile cannot do. A
WebAssembly Typst compiler could in principle run there, but it would mean a
second compilation backend with different capabilities and no language server —
a different product, not a setting. The architecture keeps the option open; the
work is not planned.

### Bundling or auto-installing Tinymist

Obsidian's developer policies forbid a plugin installing or updating its own
dependencies, and bundling a multi-megabyte binary per platform is not a
reasonable thing to put in a plugin directory. Tinymist stays a program you
install.

### A custom PDF viewer

Obsidian's PDF viewer already works, and an exported PDF is an ordinary vault
file. Registering a competing view would break the thing that makes export
useful. Covered in [the architecture notes](docs/architecture/overview.md).

### Editing Typst inside Markdown notes

Rendering Typst in a Markdown code block is a genuinely different product, and
[Typst Renderer](https://github.com/fenjalien/obsidian-typst) already does it.
This plugin is for documents that *are* Typst.

### Semantic tokens

Tinymist advertises `semanticTokensProvider`, and the plugin turns it off. The
bundled Lezer grammar already highlights Typst, synchronously and without a
round trip to the server. Adding a second source of highlighting would mean two
systems colouring the same characters, disagreeing during the window before the
server replies. One correct highlighter beats two competing ones.

### Code lens, debugging, and profiling

Tinymist offers all three: `codeLensProvider`, a full debug adapter, and
`tinymist.startServerProfiling`.

Code lens has no natural home in Obsidian's editor. The debug adapter is for
stepping through Typst evaluation, which is a compiler-development activity
rather than a writing one. Profiling and `getDocumentTrace` diagnose Tinymist's
own performance and belong in an editor aimed at people working on Tinymist.

Being available is not a reason to surface something. Each of these would add a
setting, a command, or a panel that most users would have to learn to ignore.

### Forking Tinymist

Tinymist is a dependency, not a component. If something needs changing, the
right move is a patch upstream, which benefits every editor rather than only
this one. A fork would be a last resort for a problem with no public-interface
solution, and no such problem has come up.
