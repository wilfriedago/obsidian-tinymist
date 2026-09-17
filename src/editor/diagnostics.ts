import type { Diagnostic as CodeMirrorDiagnostic } from '@codemirror/lint';
import type { Text } from '@codemirror/state';

import {
	DIAGNOSTIC_SEVERITY,
	type Diagnostic as LspDiagnostic,
} from '../typst/tinymist/protocol';
import { rangeToOffsets } from './positions';

/**
 * Turns Tinymist's diagnostics into the shape CodeMirror's linter draws.
 *
 * Kept free of editor state so it can be tested directly: given a document and
 * a list of LSP diagnostics, the offsets and severities are fully determined.
 */

const SEVERITY_NAMES: Record<number, CodeMirrorDiagnostic['severity']> = {
	[DIAGNOSTIC_SEVERITY.error]: 'error',
	[DIAGNOSTIC_SEVERITY.warning]: 'warning',
	[DIAGNOSTIC_SEVERITY.information]: 'info',
	[DIAGNOSTIC_SEVERITY.hint]: 'hint',
};

export function toCodeMirrorDiagnostics(
	doc: Text,
	diagnostics: readonly LspDiagnostic[],
): CodeMirrorDiagnostic[] {
	return diagnostics.map((diagnostic) => {
		const { from, to } = rangeToOffsets(doc, diagnostic.range);
		// Typst reports some problems as a zero-width span. A marker with no
		// width is invisible, so widen it by one character where possible.
		const widened = from === to ? Math.min(to + 1, doc.length) : to;

		return {
			from,
			to: widened,
			severity: SEVERITY_NAMES[diagnostic.severity ?? DIAGNOSTIC_SEVERITY.error] ?? 'error',
			source: diagnostic.source ?? 'typst',
			message: diagnostic.message,
		};
	});
}
