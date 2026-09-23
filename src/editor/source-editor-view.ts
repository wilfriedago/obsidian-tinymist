import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from '@codemirror/language';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import {
	Compartment,
	EditorState,
	type Extension,
	Transaction,
	type TransactionSpec,
} from '@codemirror/state';
import {
	EditorView,
	type ViewUpdate,
	drawSelection,
	highlightActiveLine,
	highlightActiveLineGutter,
	highlightSpecialChars,
	keymap,
	lineNumbers,
	rectangularSelection,
} from '@codemirror/view';
import { TextFileView, type TFile, type WorkspaceLeaf } from 'obsidian';

import type { Logger } from '../shared/logging';
import type { VaultPath } from '../shared/paths';
import type { Diagnostic } from '../typst/tinymist/protocol';
import { toCodeMirrorDiagnostics } from './diagnostics';

/**
 * What every editor this plugin owns has in common: a CodeMirror buffer that
 * Tinymist is kept in step with, and diagnostics painted into it.
 *
 * Tinymist is told about more than `.typ` files. A bibliography opened here is
 * announced too, so a document citing it compiles against the unsaved buffer
 * rather than whatever was last written to disk, and a parse error in the
 * bibliography is reported on the bibliography itself.
 *
 * Subclasses add the language: syntax, completion, and anything else that only
 * makes sense for one kind of file.
 */

export interface SourceEditorHost {
	/** Text changed in the buffer. Debounced upstream before it reaches Tinymist. */
	onDocumentChanged(vaultPath: VaultPath, text: string): void;
	onDocumentOpened(vaultPath: VaultPath, text: string): void;
	onDocumentClosed(vaultPath: VaultPath): void;
	/** Diagnostics currently known for a document. */
	getDiagnostics(vaultPath: VaultPath): readonly Diagnostic[];
	readonly logger: Logger;
}

/** How long typing settles before the buffer is pushed to Tinymist. */
const CHANGE_DEBOUNCE_MS = 150;

/** Reload disk edits without making Undo restore an obsolete document. */
export function externalReplaceSpec(state: EditorState, next: string): TransactionSpec | null {
	const previous = state.doc.toString();
	if (previous === next) return null;
	let from = 0;
	const limit = Math.min(previous.length, next.length);
	while (from < limit && previous[from] === next[from]) from += 1;
	let suffix = 0;
	while (suffix < limit - from && previous[previous.length - suffix - 1] === next[next.length - suffix - 1]) {
		suffix += 1;
	}
	return {
		changes: { from, to: previous.length - suffix, insert: next.slice(from, next.length - suffix) },
		annotations: Transaction.addToHistory.of(false),
	};
}

export abstract class SourceEditorView<Host extends SourceEditorHost = SourceEditorHost> extends TextFileView {
	protected editor: EditorView | null = null;
	private readonly diagnosticsCompartment = new Compartment();
	private changeTimer: number | null = null;
	/** Disk reloads reach the language server, but must not request another save. */
	private loading = false;

	constructor(
		leaf: WorkspaceLeaf,
		protected readonly host: Host,
	) {
		super(leaf);
	}

	/** The vault path of the open file, or `null` when there is none. */
	get vaultPath(): VaultPath | null {
		return this.file?.path ?? null;
	}

	override async onOpen(): Promise<void> {
		// Obsidian's own setup for the tab title: this is what makes it editable,
		// so a file can be renamed there the way a Markdown note can, and what a
		// new file's `rename` state lands in. Skipping it leaves a read-only title.
		await super.onOpen();

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
		this.cancelTimers();
		this.flushPendingChange();
		try {
			await super.onUnloadFile(file);
		} finally {
			this.cancelTimers();
			this.host.onDocumentClosed(file.path);
		}
	}

	/* ---------------------------------------------------------------------- */
	/* TextFileView contract                                                  */
	/* ---------------------------------------------------------------------- */

	override getViewData(): string {
		return this.editor?.state.doc.toString() ?? this.data;
	}

	override setViewData(data: string, clear: boolean): void {
		// TextFileView already watches vault modifications and merges dirty text.
		// Retain that contract. Its save path does not provide a filesystem CAS:
		// simultaneous external writers still need to coordinate their writes.
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
			} else {
				const change = externalReplaceSpec(editor.state, data);
				if (change) editor.dispatch(change);
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
	/* Operations used by the runtime                                         */
	/* ---------------------------------------------------------------------- */

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

	/**
	 * Adds `focus` to what Obsidian's base view already handles, `rename`
	 * included.
	 *
	 * The tab title asks for `{ focus: true }` when Enter, Tab, or Escape ends a
	 * rename. Obsidian's editors answer it by focusing their text, and without
	 * this the caret would be left nowhere after naming a new file.
	 */
	override setEphemeralState(state: unknown): void {
		super.setEphemeralState(state);
		if (typeof state === 'object' && state !== null && 'focus' in state && state.focus === true) {
			this.focusEditor();
		}
	}

	/* ---------------------------------------------------------------------- */
	/* Subclass hooks                                                         */
	/* ---------------------------------------------------------------------- */

	/** Syntax and language features for this kind of file. */
	protected abstract languageExtensions(): Extension[];

	/** The user moved the selection without changing the document. */
	protected onSelectionChanged(_update: ViewUpdate): void {}

	protected cancelTimers(): void {
		if (this.changeTimer !== null) {
			window.clearTimeout(this.changeTimer);
			this.changeTimer = null;
		}
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
			// Before the shared keymap, so a language's own bindings win.
			this.languageExtensions(),
			keymap.of([
				...closeBracketsKeymap,
				...defaultKeymap,
				...searchKeymap,
				...historyKeymap,
				...foldKeymap,
				indentWithTab,
			]),
			EditorView.lineWrapping,
			EditorView.updateListener.of((update) => {
				if (update.docChanged) {
					if (!this.loading) {
						this.data = update.state.doc.toString();
						// Tells Obsidian to persist the buffer on its own schedule.
						this.requestSave();
					}
					// External reloads must also replace Tinymist's in-memory text.
					this.scheduleChangePush();
				}
				if (update.selectionSet && !update.docChanged) {
					this.onSelectionChanged(update);
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
}
