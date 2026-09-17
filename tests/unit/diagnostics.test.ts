import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { toCodeMirrorDiagnostics } from '../../src/editor/diagnostics';
import { offsetToPosition, positionToOffset, rangeToOffsets } from '../../src/editor/positions';
import { DiagnosticsStore, summarizeDiagnostics } from '../../src/typst/diagnostics/store';
import { DIAGNOSTIC_SEVERITY, type Diagnostic } from '../../src/typst/tinymist/protocol';

const doc = Text.of(['#let x = 1', 'second line', 'third']);

describe('position mapping', () => {
	it('maps a position to an offset', () => {
		expect(positionToOffset(doc, { line: 0, character: 0 })).toBe(0);
		expect(positionToOffset(doc, { line: 1, character: 0 })).toBe(11);
		expect(positionToOffset(doc, { line: 1, character: 6 })).toBe(17);
	});

	it('round-trips', () => {
		const position = offsetToPosition(doc, 17);
		expect(position).toEqual({ line: 1, character: 6 });
		expect(positionToOffset(doc, position)).toBe(17);
	});

	it('clamps a position past the end of the document', () => {
		// A stale diagnostic can name a line the user has since deleted;
		// CodeMirror throws on an out-of-range offset.
		expect(positionToOffset(doc, { line: 99, character: 99 })).toBe(doc.length);
		expect(positionToOffset(doc, { line: 0, character: 999 })).toBe(10);
	});

	it('clamps a negative or non-finite position', () => {
		expect(positionToOffset(doc, { line: -5, character: -5 })).toBe(0);
		expect(positionToOffset(doc, { line: Number.NaN, character: 0 })).toBe(0);
	});

	it('orders a reversed range', () => {
		expect(
			rangeToOffsets(doc, { start: { line: 1, character: 5 }, end: { line: 0, character: 0 } }),
		).toEqual({ from: 0, to: 16 });
	});
});

describe('toCodeMirrorDiagnostics', () => {
	const at = (line: number, from: number, to: number, extra: Partial<Diagnostic> = {}) =>
		({
			range: { start: { line, character: from }, end: { line, character: to } },
			message: 'unknown variable',
			...extra,
		}) as Diagnostic;

	it('maps severities', () => {
		const mapped = toCodeMirrorDiagnostics(doc, [
			at(0, 0, 4, { severity: DIAGNOSTIC_SEVERITY.error }),
			at(1, 0, 4, { severity: DIAGNOSTIC_SEVERITY.warning }),
			at(2, 0, 4, { severity: DIAGNOSTIC_SEVERITY.information }),
			at(2, 0, 4, { severity: DIAGNOSTIC_SEVERITY.hint }),
		]);
		expect(mapped.map((d) => d.severity)).toEqual(['error', 'warning', 'info', 'hint']);
	});

	it('treats a missing severity as an error', () => {
		// Tinymist omits `severity` for plain compile errors.
		expect(toCodeMirrorDiagnostics(doc, [at(0, 0, 4)])[0]?.severity).toBe('error');
	});

	it('widens a zero-width span so the marker is visible', () => {
		const [mapped] = toCodeMirrorDiagnostics(doc, [at(0, 3, 3)]);
		expect(mapped?.from).toBe(3);
		expect(mapped?.to).toBe(4);
	});

	it('does not widen past the end of the document', () => {
		const end = { line: 2, character: 5 };
		const [mapped] = toCodeMirrorDiagnostics(doc, [
			{ range: { start: end, end }, message: 'x' } as Diagnostic,
		]);
		expect(mapped?.to).toBe(doc.length);
	});

	it('defaults the source label to typst', () => {
		expect(toCodeMirrorDiagnostics(doc, [at(0, 0, 1)])[0]?.source).toBe('typst');
	});
});

describe('DiagnosticsStore', () => {
	const error = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'e' } as Diagnostic;
	const warning = { ...error, severity: DIAGNOSTIC_SEVERITY.warning } as Diagnostic;

	it('keys by vault path, so identical basenames stay separate', () => {
		const store = new DiagnosticsStore();
		store.set('a/main.typ', [error]);
		store.set('b/main.typ', []);
		expect(store.get('a/main.typ')).toHaveLength(1);
		expect(store.get('b/main.typ')).toHaveLength(0);
	});

	it('treats an unknown document as clean', () => {
		// Tinymist publishes nothing at all for a document that compiles, so
		// "no entry" has to mean "no problems".
		expect(new DiagnosticsStore().get('never/seen.typ')).toEqual([]);
		expect(new DiagnosticsStore().summarize('never/seen.typ')).toEqual({
			errors: 0,
			warnings: 0,
			total: 0,
		});
	});

	it('notifies subscribers on change and on clear', () => {
		const store = new DiagnosticsStore();
		const seen: [string, number][] = [];
		store.onChange((path, diagnostics) => void seen.push([path, diagnostics.length]));

		store.set('a.typ', [error]);
		store.clear('a.typ');
		expect(seen).toEqual([
			['a.typ', 1],
			['a.typ', 0],
		]);
	});

	it('does not notify when clearing a document that was already clean', () => {
		const store = new DiagnosticsStore();
		const seen: string[] = [];
		store.onChange((path) => void seen.push(path));
		store.clear('never.typ');
		expect(seen).toEqual([]);
	});

	it('counts errors and warnings separately', () => {
		expect(summarizeDiagnostics([error, warning, warning])).toEqual({
			errors: 1,
			warnings: 2,
			total: 3,
		});
	});

	it('clears everything and tells subscribers', () => {
		const store = new DiagnosticsStore();
		store.set('a.typ', [error]);
		store.set('b.typ', [error]);
		const cleared: string[] = [];
		store.onChange((path) => void cleared.push(path));
		store.clearAll();
		expect([...cleared].sort()).toEqual(['a.typ', 'b.typ']);
	});
});
