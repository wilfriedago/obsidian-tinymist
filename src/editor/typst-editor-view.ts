import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { Annotation, type Extension, type Transaction } from '@codemirror/state';
import { EditorView, keymap, type ViewUpdate } from '@codemirror/view';
import { typst_lezer } from 'codemirror-lang-typst/lezer';

import type { VaultPath } from '../shared/paths';
import type { TextEdit } from '../typst/tinymist/protocol';
import {
	createCompletionSource,
	createHoverExtension,
	type LanguageFeatureContext,
} from './language-features';
import { offsetToPosition, positionToOffset, rangeToOffsets } from './positions';
import { SourceEditorView, type SourceEditorHost } from './source-editor-view';

export const TYPST_EDITOR_VIEW_TYPE = 'typst-source';

/**
 * The `.typ` editor.
 *
 * Why this is a CodeMirror instance of its own rather than a set of extensions
 * on Obsidian's editor: `registerEditorExtension` applies to Obsidian's
 * Markdown editors, and Obsidian's editor is bound to Markdown parsing and Live
 * Preview throughout. A `.typ` file is not Markdown, so it gets a view of its
 * own — which is also how Obsidian's own non-Markdown editors are built.
 *
 * The CodeMirror packages are marked `external` in the build, so this view uses
 * the very same CM6 instance Obsidian itself loaded; there is no second copy.
 *
 * Syncing the buffer with Tinymist and painting diagnostics is shared with the
 * bibliography editor, in {@link SourceEditorView}. What lives here is what
 * only a Typst document has: the grammar, completion and hover, and the
 * preview it can be shown in.
 */

export interface TypstEditorHost extends SourceEditorHost, LanguageFeatureContext {
	/** The cursor moved; used to drive source-to-preview scrolling. */
	onCursorMoved(vaultPath: VaultPath, line: number, character: number): void;
	/** The user asked for the preview from the editor's own header. */
	onTogglePreviewRequested(vaultPath: VaultPath): void;
	/** The user asked for the preview to take over this tab. */
	onShowPreviewHereRequested(vaultPath: VaultPath): void;
}

/**
 * Marks a selection change this plugin made itself, in response to the preview.
 *
 * Without it the two sync directions feed each other: clicking the preview
 * moves the cursor, the cursor move is reported back to the preview, and the
 * preview scrolls again. Annotating the transaction lets the update listener
 * tell "the user moved the caret" apart from "we moved it", which is the only
 * reliable distinction — a timing guard would still misfire on a slow machine.
 */
export const previewOriginatedSelection = Annotation.define<boolean>();

/**
 * True when a selection change came from {@link TypstEditorView.revealPosition}
 * rather than from the user. Exported so the rule can be tested directly.
 */
export function isPreviewOriginatedSelection(
	transactions: readonly Transaction[],
): boolean {
	return transactions.some(
		(transaction) => transaction.annotation(previewOriginatedSelection) === true,
	);
}

/** Cursor moves are rate-limited separately; they are cheap but frequent. */
const CURSOR_DEBOUNCE_MS = 250;

export class TypstEditorView extends SourceEditorView<TypstEditorHost> {
	private cursorTimer: number | null = null;

	override getViewType(): string {
		return TYPST_EDITOR_VIEW_TYPE;
	}

	override getIcon(): string {
		return 'file-type';
	}

	override getDisplayText(): string {
		return this.file?.basename ?? 'Typst';
	}

	override async onOpen(): Promise<void> {
		// Tab-header actions, which is where Obsidian puts per-view controls
		// (its own Markdown view uses the same slot for the reading toggle).
		// Without them the preview is reachable only from the command palette.
		//
		// Two, because the useful place for a preview depends on the window: a
		// split on a wide screen, and this very tab on a narrow one, where a
		// split leaves neither pane wide enough to read.
		this.addAction('book-open', 'Toggle Typst preview in a split', () => {
			const vaultPath = this.vaultPath;
			if (vaultPath) {
				this.host.onTogglePreviewRequested(vaultPath);
			}
		});

		this.addAction('eye', 'Show Typst preview in this tab', () => {
			const vaultPath = this.vaultPath;
			if (vaultPath) {
				this.host.onShowPreviewHereRequested(vaultPath);
			}
		});

		await super.onOpen();
	}

	/* ---------------------------------------------------------------------- */
	/* Editor operations used by commands                                     */
	/* ---------------------------------------------------------------------- */

	/**
	 * Applies LSP text edits as ranged changes.
	 *
	 * Each edit carries a range, and that range is frequently **not** the whole
	 * document: Tinymist's formatter returns a single edit that starts at the
	 * first line it actually wants to change. Treating that edit's text as the
	 * new document silently deletes everything before it — for a Typst file
	 * that is usually the `#import` and `#show` header.
	 *
	 * Applying them as ranges also means CodeMirror maps the selection through
	 * the change, so the caret survives, and the whole thing is one undo step.
	 *
	 * Returns false without touching the document when the edits cannot be
	 * applied safely, so a bad response is a no-op rather than a corruption.
	 */
	applyTextEdits(edits: readonly TextEdit[]): boolean {
		const editor = this.editor;
		if (!editor || edits.length === 0) {
			return false;
		}

		const doc = editor.state.doc;
		const changes = edits
			.map((edit) => {
				const { from, to } = rangeToOffsets(doc, edit.range);
				return { from, to, insert: edit.newText };
			})
			.sort((a, b) => a.from - b.from || a.to - b.to);

		// LSP requires edits not to overlap. CodeMirror would throw on an
		// overlapping set, so it is checked here and the format abandoned.
		for (let index = 1; index < changes.length; index += 1) {
			const previous = changes[index - 1];
			const current = changes[index];
			if (previous && current && current.from < previous.to) {
				this.host.logger.error('Refusing to apply overlapping format edits');
				return false;
			}
		}

		editor.dispatch({ changes, scrollIntoView: false });
		return true;
	}

	/**
	 * Moves the cursor to a zero-based line/character and scrolls it into view.
	 *
	 * Used to answer a preview-to-source jump, so the resulting selection change
	 * is annotated and any cursor push already queued is dropped. Otherwise the
	 * move would be echoed straight back to the preview.
	 */
	revealPosition(line: number, character: number): void {
		const editor = this.editor;
		if (!editor) {
			return;
		}

		this.cancelCursorPush();

		const offset = positionToOffset(editor.state.doc, { line, character });
		editor.dispatch({
			selection: { anchor: offset },
			effects: EditorView.scrollIntoView(offset, { y: 'center' }),
			annotations: previewOriginatedSelection.of(true),
		});
		editor.focus();
	}

	/** The cursor's current position, for source-to-preview sync. */
	getCursorPosition(): { line: number; character: number } | null {
		const editor = this.editor;
		if (!editor) {
			return null;
		}
		return offsetToPosition(editor.state.doc, editor.state.selection.main.head);
	}


	/* ---------------------------------------------------------------------- */
	/* Internals                                                              */
	/* ---------------------------------------------------------------------- */

	protected override languageExtensions(): Extension[] {
		return [
			typst_lezer(),
			autocompletion({
				// Replaces the package's offline completions: Tinymist knows the
				// real scope, imports, and package contents.
				override: [createCompletionSource(this.host)],
				activateOnTyping: true,
				closeOnBlur: true,
			}),
			createHoverExtension(this.host),
			keymap.of(completionKeymap),
		];
	}

	protected override onSelectionChanged(update: ViewUpdate): void {
		// Skip selection changes this plugin made in response to the
		// preview; reporting them back would loop.
		if (!isPreviewOriginatedSelection(update.transactions)) {
			this.scheduleCursorPush();
		}
	}

	protected override cancelTimers(): void {
		super.cancelTimers();
		this.cancelCursorPush();
	}

	private scheduleCursorPush(): void {
		if (this.cursorTimer !== null) {
			window.clearTimeout(this.cursorTimer);
		}
		this.cursorTimer = window.setTimeout(() => {
			this.cursorTimer = null;
			const path = this.vaultPath;
			const position = this.getCursorPosition();
			if (path && position) {
				this.host.onCursorMoved(path, position.line, position.character);
			}
		}, CURSOR_DEBOUNCE_MS);
	}

	private cancelCursorPush(): void {
		if (this.cursorTimer !== null) {
			window.clearTimeout(this.cursorTimer);
			this.cursorTimer = null;
		}
	}
}
