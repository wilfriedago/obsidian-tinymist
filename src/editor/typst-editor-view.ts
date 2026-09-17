import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from '@codemirror/language';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import {
	Annotation,
	Compartment,
	EditorState,
	type Extension,
	type Transaction,
} from '@codemirror/state';
import {
	EditorView,
	drawSelection,
	highlightActiveLine,
	highlightActiveLineGutter,
	highlightSpecialChars,
	keymap,
	lineNumbers,
	rectangularSelection,
} from '@codemirror/view';
import { typst_lezer } from 'codemirror-lang-typst/lezer';
import { TextFileView, type TFile, type WorkspaceLeaf } from 'obsidian';

import type { Logger } from '../shared/logging';
import type { VaultPath } from '../shared/paths';
import type { Diagnostic } from '../typst/tinymist/protocol';
import type { TextEdit } from '../typst/tinymist/protocol';
import { toCodeMirrorDiagnostics } from './diagnostics';
import {
	createCompletionSource,
	createHoverExtension,
	type LanguageFeatureContext,
} from './language-features';
import { offsetToPosition, positionToOffset, rangeToOffsets } from './positions';

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
 */

export interface TypstEditorHost extends LanguageFeatureContext {
	/** Text changed in the buffer. Debounced upstream before it reaches Tinymist. */
	onDocumentChanged(vaultPath: VaultPath, text: string): void;
	onDocumentOpened(vaultPath: VaultPath, text: string): void;
	onDocumentClosed(vaultPath: VaultPath): void;
	/** The cursor moved; used to drive source-to-preview scrolling. */
	onCursorMoved(vaultPath: VaultPath, line: number, character: number): void;
	/** The user asked for the preview from the editor's own header. */
	onTogglePreviewRequested(vaultPath: VaultPath): void;
	/** Diagnostics currently known for a document. */
	getDiagnostics(vaultPath: VaultPath): readonly Diagnostic[];
	readonly logger: Logger;
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

/** How long typing settles before the buffer is pushed to Tinymist. */
const CHANGE_DEBOUNCE_MS = 150;
/** Cursor moves are rate-limited separately; they are cheap but frequent. */
const CURSOR_DEBOUNCE_MS = 250;

export class TypstEditorView extends TextFileView {
	private editor: EditorView | null = null;
	private readonly diagnosticsCompartment = new Compartment();
	private changeTimer: number | null = null;
	private cursorTimer: number | null = null;
	/** Set while `setViewData` is loading a file, so we do not echo it back. */
	private loading = false;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly host: TypstEditorHost,
	) {
		super(leaf);
	}

	override getViewType(): string {
		return TYPST_EDITOR_VIEW_TYPE;
	}

	override getIcon(): string {
		return 'file-type';
	}

	override getDisplayText(): string {
		return this.file?.basename ?? 'Typst';
	}

	/** The vault path of the open file, or `null` when there is none. */
	get vaultPath(): VaultPath | null {
		return this.file?.path ?? null;
	}

	override async onOpen(): Promise<void> {
		// A tab-header action, which is where Obsidian puts per-view controls
		// (its own Markdown view uses the same slot for the reading toggle).
		// Without it the preview is reachable only from the command palette.
		this.addAction('book-open', 'Toggle Typst preview', () => {
			const vaultPath = this.vaultPath;
			if (vaultPath) {
				this.host.onTogglePreviewRequested(vaultPath);
			}
		});

		this.contentEl.empty();
		this.contentEl.addClass('tinymist-editor-container');

		const parent = this.contentEl.createDiv({ cls: 'tinymist-editor' });

		this.editor = new EditorView({
			parent,
			state: EditorState.create({
				doc: '',
				extensions: this.buildExtensions(),
			}),
		});
	}

	override async onClose(): Promise<void> {
		this.cancelTimers();
		this.editor?.destroy();
		this.editor = null;
		this.contentEl.empty();
	}

	override async onLoadFile(file: TFile): Promise<void> {
		await super.onLoadFile(file);
		const text = this.editor?.state.doc.toString() ?? '';
		this.host.onDocumentOpened(file.path, text);
		this.refreshDiagnostics();
	}

	override async onUnloadFile(file: TFile): Promise<void> {
		this.flushPendingChange();
		this.host.onDocumentClosed(file.path);
		await super.onUnloadFile(file);
	}

	/* ---------------------------------------------------------------------- */
	/* TextFileView contract                                                  */
	/* ---------------------------------------------------------------------- */

	override getViewData(): string {
		return this.editor?.state.doc.toString() ?? this.data;
	}

	override setViewData(data: string, clear: boolean): void {
		this.data = data;
		const editor = this.editor;
		if (!editor) {
			return;
		}

		this.loading = true;
		try {
			if (clear) {
				// A different file: rebuild the state so undo history and
				// diagnostics from the previous document do not carry over.
				editor.setState(
					EditorState.create({ doc: data, extensions: this.buildExtensions() }),
				);
			} else if (editor.state.doc.toString() !== data) {
				editor.dispatch({
					changes: { from: 0, to: editor.state.doc.length, insert: data },
				});
			}
		} finally {
			this.loading = false;
		}
	}

	override clear(): void {
		this.data = '';
		this.editor?.setState(EditorState.create({ doc: '', extensions: this.buildExtensions() }));
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

	/** Re-reads diagnostics from the host and repaints the gutter. */
	refreshDiagnostics(): void {
		const editor = this.editor;
		const path = this.vaultPath;
		if (!editor || !path) {
			return;
		}
		const diagnostics = toCodeMirrorDiagnostics(
			editor.state.doc,
			this.host.getDiagnostics(path),
		);
		editor.dispatch(setDiagnostics(editor.state, diagnostics));
	}

	focusEditor(): void {
		this.editor?.focus();
	}

	/* ---------------------------------------------------------------------- */
	/* Internals                                                              */
	/* ---------------------------------------------------------------------- */

	private buildExtensions(): Extension[] {
		return [
			lineNumbers(),
			highlightActiveLineGutter(),
			highlightSpecialChars(),
			history(),
			foldGutter(),
			drawSelection(),
			EditorState.allowMultipleSelections.of(true),
			indentOnInput(),
			indentUnit.of('  '),
			bracketMatching(),
			closeBrackets(),
			rectangularSelection(),
			highlightActiveLine(),
			highlightSelectionMatches(),
			search({ top: true }),
			lintGutter(),
			this.diagnosticsCompartment.of([]),
			typst_lezer(),
			autocompletion({
				// Replaces the package's offline completions: Tinymist knows the
				// real scope, imports, and package contents.
				override: [createCompletionSource(this.host)],
				activateOnTyping: true,
				closeOnBlur: true,
			}),
			createHoverExtension(this.host),
			keymap.of([
				...closeBracketsKeymap,
				...defaultKeymap,
				...searchKeymap,
				...historyKeymap,
				...foldKeymap,
				...completionKeymap,
				indentWithTab,
			]),
			EditorView.lineWrapping,
			EditorView.updateListener.of((update) => {
				if (update.docChanged && !this.loading) {
					this.data = update.state.doc.toString();
					// Tells Obsidian to persist the buffer on its own schedule.
					this.requestSave();
					this.scheduleChangePush();
				}
				if (update.selectionSet && !update.docChanged) {
					// Skip selection changes this plugin made in response to the
					// preview; reporting them back would loop.
					if (!isPreviewOriginatedSelection(update.transactions)) {
						this.scheduleCursorPush();
					}
				}
			}),
		];
	}

	private scheduleChangePush(): void {
		if (this.changeTimer !== null) {
			window.clearTimeout(this.changeTimer);
		}
		this.changeTimer = window.setTimeout(() => {
			this.changeTimer = null;
			this.flushPendingChange();
		}, CHANGE_DEBOUNCE_MS);
	}

	private flushPendingChange(): void {
		const path = this.vaultPath;
		const editor = this.editor;
		if (!path || !editor) {
			return;
		}
		this.host.onDocumentChanged(path, editor.state.doc.toString());
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

	private cancelTimers(): void {
		if (this.changeTimer !== null) {
			window.clearTimeout(this.changeTimer);
			this.changeTimer = null;
		}
		this.cancelCursorPush();
	}
}
