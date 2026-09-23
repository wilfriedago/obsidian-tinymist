import { history, redo, undo } from '@codemirror/commands';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import { TextFileView, type TFile, type WorkspaceLeaf } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { externalReplaceSpec } from '../../src/editor/source-editor-view';
import { TypstEditorView, type TypstEditorHost } from '../../src/editor/typst-editor-view';

describe('external editor updates', () => {
	it.each([
		['abc', 'aXbc'], ['abc', 'ac'], ['abc', 'aXYZc'],
		['abc', 'Xbc'], ['abc', 'abX'], ['abc', 'XYZ'],
		['', 'new'], ['old', ''], ['😀 text', '😀 new text'], ['😀', '😊'],
	])('replaces %j with %j', (before, after) => {
		const state = EditorState.create({ doc: before });
		expect(state.update(externalReplaceSpec(state, after)!).state.doc.toString()).toBe(after);
	});

	it('does nothing for an identical reload', () => {
		expect(externalReplaceSpec(EditorState.create({ doc: 'same' }), 'same')).toBeNull();
	});

	it('preserves a caret before the changed span and maps one after it', () => {
		for (const [anchor, expected] of [[1, 1], [7, 10]]) {
			const state = EditorState.create({ doc: 'abc def ghi', selection: { anchor: anchor! } });
			expect(state.update(externalReplaceSpec(state, 'abc longer ghi')!).state.selection.main.head).toBe(expected);
		}
	});

	it('never offers the external edit itself as an undo step', () => {
		let state = EditorState.create({ doc: 'old', extensions: [history()] });
		state = state.update(externalReplaceSpec(state, 'agent text')!).state;
		expect(undo({ state, dispatch: tr => { state = tr.state; } })).toBe(false);
		expect(state.doc.toString()).toBe('agent text');
	});

	it('undoes prior user typing while retaining an external change elsewhere', () => {
		let state = EditorState.create({ doc: 'user\nagent', extensions: [history()] });
		state = state.update({ changes: { from: 4, insert: ' edit' } }).state;
		state = state.update(externalReplaceSpec(state, 'user edit\nagent update')!).state;
		expect(undo({ state, dispatch: tr => { state = tr.state; } })).toBe(true);
		expect(state.doc.toString()).toBe('user\nagent update');
	});

	it('redo retains a non-overlapping external edit', () => {
		let state = EditorState.create({ doc: 'user\nagent', extensions: [history()] });
		state = state.update({ changes: { from: 4, insert: ' edit' } }).state;
		undo({ state, dispatch: tr => { state = tr.state; } });
		state = state.update(externalReplaceSpec(state, 'user\nagent update')!).state;
		expect(redo({ state, dispatch: tr => { state = tr.state; } })).toBe(true);
		expect(state.doc.toString()).toBe('user edit\nagent update');
	});
});

/** Real CM state/listeners and view methods; no imitation of Obsidian's save/merge. */
function harness() {
	const changed = vi.fn();
	const closed = vi.fn();
	const host = { onDocumentChanged: changed, onDocumentClosed: closed, getClient: () => null } as unknown as TypstEditorHost;
	const view = new TypstEditorView({} as WorkspaceLeaf, host);
	view.file = { path: 'sample.typ' } as TFile;
	view.requestSave = vi.fn();
	const editor = {
		state: EditorState.create(),
		setState(state: EditorState) { this.state = state; },
		dispatch(spec: TransactionSpec) {
			const transaction = this.state.update(spec);
			this.state = transaction.state;
			const update = {
				state: this.state, docChanged: transaction.docChanged,
				selectionSet: transaction.selection !== undefined, transactions: [transaction],
			} as unknown as ViewUpdate;
			for (const listener of this.state.facet(EditorView.updateListener)) listener(update);
		},
	};
	(view as unknown as { editor: unknown }).editor = editor;
	view.setViewData('original', true);
	return { view, editor, changed, closed };
}

describe('TextFileView reload contract', () => {
	afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

	it('pushes a disk reload to Tinymist without requesting a save', () => {
		vi.useFakeTimers();
		const { view, changed } = harness();
		view.setViewData('agent revision', false);
		vi.advanceTimersByTime(200);
		expect(view.getViewData()).toBe('agent revision');
		expect(changed).toHaveBeenCalledExactlyOnceWith('sample.typ', 'agent revision');
		expect(view.requestSave).not.toHaveBeenCalled();
	});

	it('does not push a change for initial load or an unchanged reload', () => {
		vi.useFakeTimers();
		const { view, changed } = harness();
		view.setViewData('original', false);
		vi.advanceTimersByTime(200);
		expect(changed).not.toHaveBeenCalled();
		expect(view.requestSave).not.toHaveBeenCalled();
	});

	it('subsequent typing saves and pushes the externally updated document', () => {
		vi.useFakeTimers();
		const { view, editor, changed } = harness();
		view.setViewData('agent revision', false);
		editor.dispatch({ changes: { from: 14, insert: '!' } });
		vi.advanceTimersByTime(200);
		expect(view.getViewData()).toBe('agent revision!');
		expect(view.requestSave).toHaveBeenCalledOnce();
		expect(changed).toHaveBeenCalledExactlyOnceWith('sample.typ', 'agent revision!');
	});

	it('coalesces pending typing and successive reloads into the latest text', () => {
		vi.useFakeTimers();
		const { view, editor, changed } = harness();
		editor.dispatch({ changes: { from: 8, insert: ' user' } });
		view.setViewData('original user, agent edit', false);
		view.setViewData('original user, newer agent edit', false);
		vi.advanceTimersByTime(200);
		expect(changed).toHaveBeenCalledExactlyOnceWith('sample.typ', 'original user, newer agent edit');
		expect(view.requestSave).toHaveBeenCalledOnce();
	});

	it('resets history on file switch without a change push', () => {
		vi.useFakeTimers();
		const { view, editor, changed } = harness();
		editor.dispatch({ changes: { from: 8, insert: ' user' } });
		vi.advanceTimersByTime(200);
		changed.mockClear();
		view.setViewData('different document', true);
		vi.advanceTimersByTime(200);
		expect(changed).not.toHaveBeenCalled();
		expect(undo({ state: editor.state, dispatch: tr => editor.setState(tr.state) })).toBe(false);
	});

	it('waits for the base save before closing and cancels pending pushes', async () => {
		vi.useFakeTimers();
		const { view, changed, closed } = harness();
		let finishSave!: () => void;
		vi.spyOn(TextFileView.prototype, 'onUnloadFile').mockImplementation(() =>
			new Promise<void>(resolve => { finishSave = resolve; }),
		);
		view.setViewData('agent revision', false);
		const unloading = view.onUnloadFile(view.file!);
		expect(changed).toHaveBeenCalledExactlyOnceWith('sample.typ', 'agent revision');
		expect(closed).not.toHaveBeenCalled();
		finishSave();
		await unloading;
		expect(closed).toHaveBeenCalledExactlyOnceWith('sample.typ');
		vi.advanceTimersByTime(200);
		expect(changed).toHaveBeenCalledOnce();
	});

	it('closes the language-server document and propagates a failed base save', async () => {
		vi.useFakeTimers();
		const { view, changed, closed } = harness();
		const failure = new Error('disk write failed');
		vi.spyOn(TextFileView.prototype, 'onUnloadFile').mockRejectedValue(failure);
		view.setViewData('agent revision', false);
		await expect(view.onUnloadFile(view.file!)).rejects.toBe(failure);
		expect(closed).toHaveBeenCalledExactlyOnceWith('sample.typ');
		vi.advanceTimersByTime(200);
		expect(changed).toHaveBeenCalledOnce();
	});
});
