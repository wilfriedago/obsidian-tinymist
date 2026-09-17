import { EditorState, Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { rangeToOffsets } from '../../src/editor/positions';
import type { TextEdit } from '../../src/typst/tinymist/protocol';

/**
 * Applies edits the way `TypstEditorView.applyTextEdits` does, without needing
 * a DOM. The view builds exactly these changes and hands them to CodeMirror.
 */
function applyEdits(doc: Text, edits: readonly TextEdit[]): string {
	const changes = edits
		.map((edit) => {
			const { from, to } = rangeToOffsets(doc, edit.range);
			return { from, to, insert: edit.newText };
		})
		.sort((a, b) => a.from - b.from || a.to - b.to);

	const state = EditorState.create({ doc });
	return state.update({ changes }).state.doc.toString();
}

describe('applying formatter edits', () => {
	/**
	 * The real shape Tinymist 0.15.8 returns: one edit whose range starts part
	 * way into the document, not at its beginning. Treating `newText` as the
	 * whole new document deletes the `#import` header — which is exactly the
	 * corruption this pins.
	 */
	it('keeps the header a partial-range edit does not cover', () => {
		const original = [
			'#import "@preview/charged-ieee:0.1.4": ieee',
			'',
			'#show   ieee.with(',
			'  title: [A Paper],',
			')',
		].join('\n');
		const doc = Text.of(original.split('\n'));

		// Starts at line 2, character 6 — after `#show `.
		const edit: TextEdit = {
			range: { start: { line: 2, character: 6 }, end: { line: 4, character: 1 } },
			newText: 'ieee.with(\n  title: [A Paper],\n)',
		};

		const result = applyEdits(doc, [edit]);

		expect(result).toContain('#import "@preview/charged-ieee:0.1.4": ieee');
		expect(result.startsWith('#import')).toBe(true);
		expect(result).toBe(
			['#import "@preview/charged-ieee:0.1.4": ieee', '', '#show ieee.with(', '  title: [A Paper],', ')'].join('\n'),
		);

		// What the old whole-document replace produced, for contrast.
		expect(edit.newText.startsWith('#import')).toBe(false);
	});

	it('applies several edits without their offsets drifting', () => {
		const doc = Text.of(['aaa', 'bbb', 'ccc']);
		const edits: TextEdit[] = [
			{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'X' },
			{ range: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } }, newText: 'ZZZZZ' },
		];
		expect(applyEdits(doc, edits)).toBe('X\nbbb\nZZZZZ');
	});

	it('is order-independent, since LSP does not promise sorted edits', () => {
		const doc = Text.of(['aaa', 'bbb', 'ccc']);
		const later: TextEdit = {
			range: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } },
			newText: 'Z',
		};
		const earlier: TextEdit = {
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
			newText: 'A',
		};
		expect(applyEdits(doc, [later, earlier])).toBe('A\nbbb\nZ');
	});

	it('handles a genuine whole-document edit too', () => {
		const doc = Text.of(['one', 'two']);
		const edit: TextEdit = {
			range: { start: { line: 0, character: 0 }, end: { line: 1, character: 3 } },
			newText: 'replaced',
		};
		expect(applyEdits(doc, [edit])).toBe('replaced');
	});

	it('handles a pure insertion, where the range is empty', () => {
		const doc = Text.of(['ab']);
		const edit: TextEdit = {
			range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
			newText: '-',
		};
		expect(applyEdits(doc, [edit])).toBe('a-b');
	});

	it('clamps a range that runs past the end of the document', () => {
		const doc = Text.of(['short']);
		const edit: TextEdit = {
			range: { start: { line: 0, character: 0 }, end: { line: 9, character: 99 } },
			newText: 'new',
		};
		expect(applyEdits(doc, [edit])).toBe('new');
	});
});
