/**
 * The Language Server Protocol surface this plugin actually uses, plus the
 * base-protocol framing.
 *
 * Only messages that Tinymist has been verified to implement appear here. The
 * Tinymist-specific command and notification names were read off its handler
 * registration (`crates/tinymist/src/server.rs`), not guessed.
 */

export const JSONRPC_VERSION = '2.0';

export type RequestId = number | string;

export interface RequestMessage {
	jsonrpc: typeof JSONRPC_VERSION;
	id: RequestId;
	method: string;
	params?: unknown;
}

export interface NotificationMessage {
	jsonrpc: typeof JSONRPC_VERSION;
	method: string;
	params?: unknown;
}

export interface ResponseError {
	code: number;
	message: string;
	data?: unknown;
}

export interface ResponseMessage {
	jsonrpc: typeof JSONRPC_VERSION;
	id: RequestId | null;
	result?: unknown;
	error?: ResponseError;
}

export type IncomingMessage = ResponseMessage | NotificationMessage | RequestMessage;

export function isResponse(message: IncomingMessage): message is ResponseMessage {
	return 'id' in message && !('method' in message);
}

export function isRequest(message: IncomingMessage): message is RequestMessage {
	return 'id' in message && 'method' in message;
}

export function isNotification(message: IncomingMessage): message is NotificationMessage {
	return !('id' in message) && 'method' in message;
}

/* -------------------------------------------------------------------------- */
/* Base protocol framing                                                      */
/* -------------------------------------------------------------------------- */

/** Serializes a message with the `Content-Length` header LSP requires. */
export function encodeMessage(message: RequestMessage | NotificationMessage | ResponseMessage): Buffer {
	const body = Buffer.from(JSON.stringify(message), 'utf8');
	const header = Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, 'ascii');
	return Buffer.concat([header, body]);
}

/**
 * Incremental decoder for the `Content-Length` framing.
 *
 * Tinymist's stdout arrives in arbitrary chunks, so a message may be split
 * across reads and several messages may share one read. The decoder keeps a
 * buffer across `append` calls and yields only whole messages.
 */
export class MessageDecoder {
	private buffer: Buffer = Buffer.alloc(0);

	/** Feeds a chunk in and returns every message that is now complete. */
	append(chunk: Buffer): IncomingMessage[] {
		this.buffer = this.buffer.byteLength === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

		const messages: IncomingMessage[] = [];
		for (;;) {
			const headerEnd = this.buffer.indexOf('\r\n\r\n', 0, 'ascii');
			if (headerEnd === -1) {
				break;
			}

			const header = this.buffer.subarray(0, headerEnd).toString('ascii');
			const contentLength = parseContentLength(header);
			if (contentLength === null) {
				// Unrecoverable: we cannot know where this message ends, so drop
				// the bad header and resynchronize on the next one.
				this.buffer = this.buffer.subarray(headerEnd + 4);
				continue;
			}

			const bodyStart = headerEnd + 4;
			const bodyEnd = bodyStart + contentLength;
			if (this.buffer.byteLength < bodyEnd) {
				break;
			}

			const body = this.buffer.subarray(bodyStart, bodyEnd).toString('utf8');
			this.buffer = this.buffer.subarray(bodyEnd);

			try {
				messages.push(JSON.parse(body) as IncomingMessage);
			} catch {
				// A malformed body is skipped rather than killing the stream.
			}
		}

		return messages;
	}

	reset(): void {
		this.buffer = Buffer.alloc(0);
	}

	/** Bytes held pending a complete message. Used by tests and diagnostics. */
	get pendingBytes(): number {
		return this.buffer.byteLength;
	}
}

function parseContentLength(header: string): number | null {
	for (const line of header.split('\r\n')) {
		const separator = line.indexOf(':');
		if (separator === -1) {
			continue;
		}
		if (line.slice(0, separator).trim().toLowerCase() !== 'content-length') {
			continue;
		}
		const value = Number.parseInt(line.slice(separator + 1).trim(), 10);
		return Number.isFinite(value) && value >= 0 ? value : null;
	}
	return null;
}

/* -------------------------------------------------------------------------- */
/* LSP types, narrowed to what the plugin consumes                            */
/* -------------------------------------------------------------------------- */

export interface Position {
	line: number;
	character: number;
}

export interface Range {
	start: Position;
	end: Position;
}

export interface Location {
	uri: string;
	range: Range;
}

export interface TextEdit {
	range: Range;
	newText: string;
}

export const DIAGNOSTIC_SEVERITY = {
	error: 1,
	warning: 2,
	information: 3,
	hint: 4,
} as const;

export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITY)[keyof typeof DIAGNOSTIC_SEVERITY];

export interface Diagnostic {
	range: Range;
	severity?: DiagnosticSeverity;
	code?: string | number;
	source?: string;
	message: string;
}

export interface PublishDiagnosticsParams {
	uri: string;
	version?: number;
	diagnostics: Diagnostic[];
}

export interface CompletionItem {
	label: string;
	kind?: number;
	detail?: string;
	documentation?: string | { kind: string; value: string };
	sortText?: string;
	filterText?: string;
	insertText?: string;
	insertTextFormat?: 1 | 2;
	textEdit?: { range: Range; newText: string };
}

export interface CompletionList {
	isIncomplete: boolean;
	items: CompletionItem[];
}

export interface Hover {
	contents: string | { kind: string; value: string } | (string | { kind: string; value: string })[];
	range?: Range;
}

export interface DocumentSymbol {
	name: string;
	detail?: string;
	kind: number;
	range: Range;
	selectionRange: Range;
	children?: DocumentSymbol[];
}

/* -------------------------------------------------------------------------- */
/* Tinymist-specific protocol extensions                                      */
/* -------------------------------------------------------------------------- */

/**
 * Notifications Tinymist sends that this plugin subscribes to. Verified against
 * `crates/tinymist/src/server.rs` and the reference client in
 * `editors/vscode/src/lsp.ts` at Tinymist 0.15.8.
 */
export const TINYMIST_NOTIFICATION = {
	/** Compile lifecycle updates, used to drive the status bar. */
	compileStatus: 'tinymist/compileStatus',
	/** The preview asks the editor to reveal a source location (preview -> source). */
	previewScrollSource: 'tinymist/preview/scrollSource',
	/** A preview task has ended and its client state should be torn down. */
	previewDispose: 'tinymist/preview/dispose',
	/** Document outline updates for the active preview. */
	documentOutline: 'tinymist/documentOutline',
} as const;

/** Commands invoked through `workspace/executeCommand`. */
export const TINYMIST_COMMAND = {
	startPreview: 'tinymist.doStartPreview',
	killPreview: 'tinymist.doKillPreview',
	scrollPreview: 'tinymist.scrollPreview',
	exportPdf: 'tinymist.exportPdf',
	getServerInfo: 'tinymist.getServerInfo',
	getResources: 'tinymist.getResources',
	pinMain: 'tinymist.pinMain',
	focusMain: 'tinymist.focusMain',
} as const;

export interface CompileStatusParams {
	status: 'compiling' | 'compileSuccess' | 'compileError';
	path: string;
	pageCount?: number;
}

/** Payload of `tinymist/preview/scrollSource`: where to put the cursor. */
export interface PreviewJumpInfo {
	filepath: string;
	/** `[line, character]`, both zero-based. `null` when unknown. */
	start: [number, number] | null;
	end: [number, number] | null;
}

/** Result of `tinymist.doStartPreview`. */
export interface StartPreviewResult {
	staticServerPort?: number;
	staticServerAddr?: string;
	dataPlanePort?: number;
	isPrimary?: boolean;
}

/** Argument to `tinymist.scrollPreview` (source -> preview). */
export interface PreviewScrollRequest {
	event: 'panelScrollTo' | 'changeCursorPosition';
	filepath: string;
	line: number;
	character: number;
}

/** Single-document result shape of the `tinymist.export*` commands. */
export interface ExportResult {
	path: string | null;
	data: string | null;
}
