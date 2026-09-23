import { View, type App, type TFolder, type WorkspaceLeaf } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BibliographyEditorView } from '../../src/editor/bibliography-editor-view';
import type { SourceEditorHost } from '../../src/editor/source-editor-view';
import { createFile } from '../../src/plugin/new-file';

/**
 * `Untitled` is never the name anyone wants, so a new file opens with its name
 * selected, the way Obsidian's own "New note" and "New canvas" do. Obsidian's
 * base view does the rest: the tab title when it is shown, the rename dialog
 * when it is hidden. What the plugin owes it is asking, and a title it can edit.
 */
describe('a newly created file', () => {
	it('opens with its name selected for renaming', async () => {
		const openFile = vi.fn();
		const file = { path: 'papers/Untitled.bib' };
		const app = {
			vault: { getAbstractFileByPath: () => null, create: vi.fn(async () => file) },
			workspace: { getLeaf: () => ({ openFile }) },
		} as unknown as App;

		await createFile(app, { path: 'papers' } as TFolder, 'bib');

		expect(openFile).toHaveBeenCalledExactlyOnceWith(file, {
			active: true,
			eState: { rename: 'all' },
		});
	});
});

describe('the editor behind the tab title', () => {
	afterEach(() => vi.restoreAllMocks());

	const view = () => new BibliographyEditorView({} as WorkspaceLeaf, {} as SourceEditorHost);

	it('runs Obsidian’s own setup, which is what makes the title editable', async () => {
		// `protected` in Obsidian's typings, public at runtime.
		const base = vi.spyOn(View.prototype as unknown as { onOpen(): Promise<void> }, 'onOpen');
		const editor = view();
		// Stop before CodeMirror is built; only the call order matters here.
		(editor as unknown as { contentEl: unknown }).contentEl = {
			empty: () => {
				throw new Error('stop');
			},
		};
		await expect(editor.onOpen()).rejects.toThrow('stop');
		expect(base).toHaveBeenCalledOnce();
	});

	it('takes focus back when the title hands it over', () => {
		const editor = view();
		const focus = vi.spyOn(editor, 'focusEditor').mockImplementation(() => undefined);
		editor.setEphemeralState({ rename: 'all' });
		expect(focus).not.toHaveBeenCalled();
		editor.setEphemeralState({ focus: true });
		expect(focus).toHaveBeenCalledOnce();
	});

	it('still passes every state to Obsidian’s base view', () => {
		const base = vi.spyOn(View.prototype, 'setEphemeralState');
		view().setEphemeralState({ rename: 'all' });
		expect(base).toHaveBeenCalledWith({ rename: 'all' });
	});
});
