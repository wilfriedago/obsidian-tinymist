# Third-party notices

This plugin is distributed under the MIT license (see `LICENSE`). It bundles,
depends on, or interoperates with the third-party works listed below.

## Bundled into `main.js`

### codemirror-lang-typst

- Source: <https://github.com/kxxt/codemirror-lang-typst>
- License: Apache-2.0
- Use: Typst grammar and syntax highlighting for the CodeMirror 6 editor.

Licensed under the Apache License, Version 2.0. You may obtain a copy of the
License at <http://www.apache.org/licenses/LICENSE-2.0>. Unless required by
applicable law or agreed to in writing, software distributed under the License
is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
KIND, either express or implied.

## Provided by the Obsidian runtime (not bundled)

The CodeMirror 6 packages (`@codemirror/*`, `@lezer/*`) are marked `external`
in the build and are resolved against the copies Obsidian already loads. They
are declared as devDependencies for type checking only.

- CodeMirror 6 — MIT — <https://github.com/codemirror/dev>
- Lezer — MIT — <https://github.com/lezer-parser>

## External program (not bundled, not distributed)

### Tinymist

- Source: <https://github.com/Myriad-Dreamin/tinymist>
- License: Apache-2.0
- Use: Typst language server, compiler, preview server, and exporter.

Tinymist is **not** bundled with, distributed by, or modified by this plugin.
The plugin launches a Tinymist executable that the user installs and configures
themselves. No Tinymist source code has been copied into this repository.

The plugin's wire protocol usage (LSP command names, notification names, and
argument shapes) was derived by reading Tinymist's public interfaces. Protocol
identifiers such as `tinymist.doStartPreview` are facts about an interface, not
copied implementation.

## Trademark and affiliation

This plugin is an independent, unofficial integration. It is not affiliated
with, endorsed by, or sponsored by the Tinymist project, the Typst project, or
Obsidian. "Tinymist", "Typst", and "Obsidian" are the marks of their respective
owners.
