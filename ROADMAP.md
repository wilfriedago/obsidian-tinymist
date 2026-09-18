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

The guiding rule is the one the plugin was built on: **Tinymist owns Typst, the
plugin owns Obsidian.** Anything the language server can already do should be
surfaced rather than reimplemented. That is what keeps the plugin small and
Tinymist upgradable.

If something here matters to you, say so in an
[issue](https://github.com/wilfriedago/obsidian-tinymist/issues) — what people
actually hit moves faster than what looks good on a list.

---

## Next

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

### Outline and document symbols in Obsidian's sidebar

Tinymist already sends `tinymist/documentOutline`, and answers
`textDocument/documentSymbol`. The plugin subscribes to neither. Feeding
Obsidian's outline view would make a long document navigable the way a Markdown
note is.

The question is whether Obsidian's outline can be populated by a plugin for a
non-Markdown view, or whether this needs a view of its own.

### Go to definition, references, and rename

Tinymist answers all three, and the plugin already declares the client
capabilities. What is missing is the editor-side wiring: a command, a keybinding,
and somewhere sensible to show references. Rename in particular wants care,
since it edits files that may not be open.

### Settings that apply without a restart

Changing the executable, project strategy, fonts, or formatter restarts
Tinymist today, which is honest but visibly slow on a large project. Some of
those keys may apply live through `workspace/didChangeConfiguration`. Worth
measuring which, rather than assuming.

Tracked as [R10](docs/risks.md#r10-settings-changes-require-a-restart).

### Export beyond PDF

Tinymist exposes PNG, SVG, HTML, Markdown, and LaTeX export through the same
command surface the PDF export already uses, so the mechanism exists. The
question is UI: a submenu, a modal, or a command per format, without turning a
tidy palette into a wall of entries.

### Incremental document sync

Full document text is sent on every debounced change. Simple and impossible to
desynchronize, but wasteful on a very large file. Worth measuring before
optimizing — Tinymist's compile cost is expected to dominate.

Tracked as [R9](docs/risks.md#r9-no-incremental-document-sync).

### Snippets and templates for a new file

**New Typst file** creates an empty document, deliberately. A separate "new
from template" affordance, reading templates from a vault folder, would be the
honest way to offer a starting point without guessing at one.

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

### Forking Tinymist

Tinymist is a dependency, not a component. If something needs changing, the
right move is a patch upstream, which benefits every editor rather than only
this one. A fork would be a last resort for a problem with no public-interface
solution, and no such problem has come up.

<!-- CI path-filter verification. This branch is deleted after the test. -->
