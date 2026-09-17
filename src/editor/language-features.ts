import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { hoverTooltip, type Tooltip } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';

import type { Logger } from '../shared/logging';
import type { TinymistClient } from '../typst/tinymist/client';
import type {
	CompletionItem,
	CompletionList,
	Hover,
	TextEdit,
} from '../typst/tinymist/protocol';
import { offsetToPosition, rangeToOffsets } from './positions';

/**
 * Completion and hover, answered by Tinymist rather than by a local heuristic.
 *
 * Every provider here checks the corresponding server capability first. If
 * Tinymist does not advertise it, the feature is simply absent rather than
 * silently returning nothing — which keeps the editor honest about what works.
 */

export interface LanguageFeatureContext {
	/** The live client, or `null` while Tinymist is down. */
	getClient(): TinymistClient | null;
	/** Document URI for the buffer this editor is showing. */
	getDocumentUri(): string | null;
	readonly logger: Logger;
}

/* -------------------------------------------------------------------------- */
/* Completion                                                                 */
/* -------------------------------------------------------------------------- */

/** LSP `CompletionItemKind` -> CodeMirror's completion type vocabulary. */
const COMPLETION_KINDS: Record<number, string> = {
	1: 'text',
	2: 'method',
	3: 'function',
	4: 'function',
	5: 'property',
	6: 'variable',
	7: 'class',
	8: 'interface',
	9: 'namespace',
	10: 'property',
	11: 'variable',
	12: 'constant',
	13: 'enum',
	14: 'keyword',
	15: 'text',
	16: 'constant',
	17: 'text',
	18: 'variable',
	21: 'constant',
	22: 'class',
	23: 'variable',
	25: 'type',
};

export function createCompletionSource(context: LanguageFeatureContext) {
	return async (completionContext: CompletionContext): Promise<CompletionResult | null> => {
		const client = context.getClient();
		const uri = context.getDocumentUri();
		if (!client || !uri || !client.supportsCapability('completionProvider')) {
			return null;
		}

		const position = offsetToPosition(completionContext.state.doc, completionContext.pos);

		let response: CompletionList | CompletionItem[] | null;
		try {
			response = await client.request<CompletionList | CompletionItem[] | null>(
				'textDocument/completion',
				{
					textDocument: { uri },
					position,
					context: { triggerKind: completionContext.explicit ? 1 : 2 },
				},
				8_000,
			);
		} catch (error) {
			context.logger.debug('Completion request failed', error);
			return null;
		}

		const items = Array.isArray(response) ? response : (response?.items ?? []);
		if (items.length === 0) {
			return null;
		}

		// Derive the replaced range from the first item's own edit where the
		// server provides one; it knows Typst's token boundaries better than a
		// generic word regex does.
		const explicitRange = firstEditRange(completionContext.state, items);
		const word = completionContext.matchBefore(/[\p{L}\p{N}_.#-]+/u);
		const from = explicitRange?.from ?? word?.from ?? completionContext.pos;

		if (!completionContext.explicit && from === completionContext.pos && !word) {
			return null;
		}

		return {
			from,
			options: items.map(toCodeMirrorCompletion),
			// Tinymist recomputes as the prefix changes; re-asking keeps
			// context-sensitive results (like field access) correct.
			validFor: /^[\p{L}\p{N}_.-]*$/u,
		};
	};
}

function firstEditRange(
	state: EditorState,
	items: readonly CompletionItem[],
): { from: number; to: number } | null {
	for (const item of items) {
		if (item.textEdit) {
			return rangeToOffsets(state.doc, item.textEdit.range);
		}
	}
	return null;
}

function toCodeMirrorCompletion(item: CompletionItem): Completion {
	const insert = item.textEdit?.newText ?? item.insertText ?? item.label;
	const isSnippet = item.insertTextFormat === 2;

	return {
		label: item.label,
		...(item.kind !== undefined && COMPLETION_KINDS[item.kind]
			? { type: COMPLETION_KINDS[item.kind] }
			: {}),
		...(item.detail ? { detail: item.detail } : {}),
		...(item.sortText ? { boost: 0 } : {}),
		// Snippet placeholders (`${1:body}`) would be inserted literally, so the
		// placeholders are stripped rather than shown as noise.
		apply: isSnippet ? stripSnippetPlaceholders(insert) : insert,
		...(documentationOf(item) ? { info: () => renderInfo(documentationOf(item)) } : {}),
	};
}

function documentationOf(item: CompletionItem): string {
	const documentation = item.documentation;
	if (!documentation) {
		return '';
	}
	return typeof documentation === 'string' ? documentation : documentation.value;
}

function renderInfo(text: string): HTMLElement {
	// Obsidian's global `createDiv` builds a detached element against the
	// active document, so this stays correct in a popout window.
	const element = createDiv({ cls: 'tinymist-completion-info' });
	element.textContent = text;
	return element;
}

/**
 * Converts an LSP snippet to plain text.
 *
 * `${1:name}` becomes `name`, `$0` disappears. Implementing real snippet
 * expansion would mean reimplementing CodeMirror's snippet engine against
 * LSP's grammar; inserting readable text is the honest smaller thing.
 */
export function stripSnippetPlaceholders(snippet: string): string {
	// An escaped `\$` is a literal dollar and must not be read as a tabstop, so
	// it is parked behind a sentinel before the tabstop rules run and restored
	// afterwards. Doing the unescape last would turn `\$5` into a bare
	// backslash.
	const ESCAPED_DOLLAR = '\u0000tinymist-dollar\u0000';

	return snippet
		.replace(/\\\$/g, ESCAPED_DOLLAR)
		.replace(/\$\{\d+:([^}]*)\}/g, '$1')
		.replace(/\$\{\d+\|([^,|]*)(?:,[^|]*)?\|\}/g, '$1')
		.replace(/\$\{\d+\}/g, '')
		.replace(/\$\d+/g, '')
		.split(ESCAPED_DOLLAR)
		.join('$');
}

/* -------------------------------------------------------------------------- */
/* Hover                                                                      */
/* -------------------------------------------------------------------------- */

export function createHoverExtension(context: LanguageFeatureContext) {
	return hoverTooltip(async (view, pos): Promise<Tooltip | null> => {
		const client = context.getClient();
		const uri = context.getDocumentUri();
		if (!client || !uri || !client.supportsCapability('hoverProvider')) {
			return null;
		}

		let hover: Hover | null;
		try {
			hover = await client.request<Hover | null>(
				'textDocument/hover',
				{ textDocument: { uri }, position: offsetToPosition(view.state.doc, pos) },
				6_000,
			);
		} catch (error) {
			context.logger.debug('Hover request failed', error);
			return null;
		}

		const text = hoverText(hover);
		if (!text) {
			return null;
		}

		const range = hover?.range ? rangeToOffsets(view.state.doc, hover.range) : null;

		return {
			pos: range?.from ?? pos,
			end: range?.to ?? pos,
			above: true,
			create: () => {
				// `textContent`, never `innerHTML`: hover content is derived from
				// the document, which is untrusted input.
				const dom = createDiv({ cls: 'tinymist-hover' });
				for (const line of text.split('\n')) {
					dom.createDiv({ cls: 'tinymist-hover-line' }).textContent = line;
				}
				return { dom };
			},
		};
	});
}

export function hoverText(hover: Hover | null): string {
	if (!hover) {
		return '';
	}
	const { contents } = hover;
	const parts = Array.isArray(contents) ? contents : [contents];
	return parts
		.map((part) => (typeof part === 'string' ? part : part.value))
		.join('\n')
		.trim();
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

/** Applies `textDocument/formatting` edits, or reports why it could not. */
export async function requestFormattingEdits(
	client: TinymistClient,
	uri: string,
): Promise<TextEdit[]> {
	if (!client.supportsCapability('documentFormattingProvider')) {
		return [];
	}
	const edits = await client.request<TextEdit[] | null>('textDocument/formatting', {
		textDocument: { uri },
		options: { tabSize: 2, insertSpaces: true },
	});
	return edits ?? [];
}
