import type { Text } from '@codemirror/state';

import type { Position, Range } from '../typst/tinymist/protocol';

/**
 * Converting between LSP positions and CodeMirror offsets.
 *
 * The client advertises `utf-16` as its position encoding, which is the LSP
 * default and happens to match how JavaScript indexes strings, so a character
 * column is a direct index into the line. Everything is clamped: a stale
 * diagnostic can name a position past the end of a document the user has since
 * shortened, and an out-of-range offset would make CodeMirror throw.
 */

export function positionToOffset(doc: Text, position: Position): number {
	const lineNumber = clamp(position.line + 1, 1, doc.lines);
	const line = doc.line(lineNumber);
	const character = clamp(position.character, 0, line.length);
	return line.from + character;
}

export function offsetToPosition(doc: Text, offset: number): Position {
	const clamped = clamp(offset, 0, doc.length);
	const line = doc.lineAt(clamped);
	return { line: line.number - 1, character: clamped - line.from };
}

/** Converts an LSP range, guaranteeing `from <= to`. */
export function rangeToOffsets(doc: Text, range: Range): { from: number; to: number } {
	const from = positionToOffset(doc, range.start);
	const to = positionToOffset(doc, range.end);
	return from <= to ? { from, to } : { from: to, to: from };
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) {
		return min;
	}
	return Math.min(Math.max(Math.trunc(value), min), max);
}
