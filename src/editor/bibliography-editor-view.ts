import type { Extension } from '@codemirror/state';

import { SourceEditorView } from './source-editor-view';

export const BIBLIOGRAPHY_EDITOR_VIEW_TYPE = 'typst-bibliography';

/**
 * The editor for a bibliography a Typst document cites: BibLaTeX `.bib`, and
 * Hayagriva `.yml` when the user opts in.
 *
 * It is a plain text editor on purpose. Tinymist compiles against the buffer
 * and reports parse errors on it, which the shared base already wires up, but
 * it offers no completion or hover inside a bibliography, so there is nothing
 * else to connect. There is also no preview: a bibliography is not a document
 * that renders on its own.
 */
export class BibliographyEditorView extends SourceEditorView {
	override getViewType(): string {
		return BIBLIOGRAPHY_EDITOR_VIEW_TYPE;
	}

	override getIcon(): string {
		return 'book-marked';
	}

	override getDisplayText(): string {
		return this.file?.basename ?? 'Bibliography';
	}

	protected override languageExtensions(): Extension[] {
		// No highlighting yet, for either format: there is no maintained
		// CodeMirror 6 BibTeX mode, and a YAML one would be the plugin's first
		// runtime dependency beyond the Typst grammar.
		return [];
	}
}
