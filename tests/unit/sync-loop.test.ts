import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import {
	isPreviewOriginatedSelection,
	previewOriginatedSelection,
} from '../../src/editor/typst-editor-view';

/**
 * Source and preview sync in both directions, which is a feedback loop waiting
 * to happen: clicking the preview moves the cursor, and moving the cursor
 * scrolls the preview. The annotation is what breaks it — a selection change
 * the plugin made in response to the preview must not be reported back.
 */
describe('preview-to-source echo suppression', () => {
	const state = EditorState.create({ doc: 'line one\nline two\nline three' });

	it('recognizes a selection the plugin made answering the preview', () => {
		const transaction = state.update({
			selection: { anchor: 4 },
			annotations: previewOriginatedSelection.of(true),
		});
		expect(isPreviewOriginatedSelection([transaction])).toBe(true);
	});

	it('does not suppress a selection the user made', () => {
		const transaction = state.update({ selection: { anchor: 4 } });
		expect(isPreviewOriginatedSelection([transaction])).toBe(false);
	});

	it('does not suppress ordinary typing', () => {
		const transaction = state.update({ changes: { from: 0, insert: '#' } });
		expect(isPreviewOriginatedSelection([transaction])).toBe(false);
	});

	it('suppresses when any transaction in the update carries the annotation', () => {
		// CodeMirror can batch several transactions into one update.
		const user = state.update({ selection: { anchor: 1 } });
		const plugin = state.update({
			selection: { anchor: 4 },
			annotations: previewOriginatedSelection.of(true),
		});
		expect(isPreviewOriginatedSelection([user, plugin])).toBe(true);
	});

	it('treats an empty update as the user', () => {
		expect(isPreviewOriginatedSelection([])).toBe(false);
	});

	it('does not leak the annotation into later transactions', () => {
		// The loop would come back if the annotation were sticky: the next
		// caret move the user makes must still reach the preview.
		const annotated = state.update({
			selection: { anchor: 4 },
			annotations: previewOriginatedSelection.of(true),
		});
		const next = annotated.state.update({ selection: { anchor: 9 } });
		expect(isPreviewOriginatedSelection([next])).toBe(false);
	});
});
