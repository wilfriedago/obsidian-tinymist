import { TypstError, asTypstError } from '../../shared/errors';
import type { Logger } from '../../shared/logging';
import {
	JSONRPC_VERSION,
	isNotification,
	isRequest,
	isResponse,
	type IncomingMessage,
	type NotificationMessage,
	type RequestId,
	type RequestMessage,
	type ResponseMessage,
} from './protocol';

/**
 * LSP semantics over a framed byte channel.
 *
 * Owns request/response correlation, the initialize handshake, and the
 * server-to-client direction. It has no opinion about how the bytes move, which
 * is what lets the unit tests drive it over an in-memory transport.
 */

/** What the client needs from whatever is carrying the bytes. */
export interface ClientTransport {
	send(message: RequestMessage | NotificationMessage | ResponseMessage): void;
}

export type NotificationHandler = (params: unknown) => void;
export type ServerRequestHandler = (params: unknown) => unknown;

/** Requests that outlive this budget are rejected so the UI never hangs. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
/** `initialize` gets longer: a cold Tinymist scans fonts before replying. */
export const INITIALIZE_TIMEOUT_MS = 60_000;

interface PendingRequest {
	readonly method: string;
	resolve(value: unknown): void;
	reject(error: unknown): void;
	timer: number;
}

export interface InitializeOptions {
	/** Absolute path used as the single workspace root, or `null` for none. */
	readonly rootPath: string | null;
	/** Tinymist's `initializationOptions` payload. */
	readonly initializationOptions: Record<string, unknown>;
}

export interface ServerCapabilities {
	completionProvider?: unknown;
	hoverProvider?: unknown;
	definitionProvider?: unknown;
	referencesProvider?: unknown;
	documentSymbolProvider?: unknown;
	documentFormattingProvider?: unknown;
	codeActionProvider?: unknown;
	executeCommandProvider?: { commands?: string[] };
	[key: string]: unknown;
}

export interface InitializeResult {
	capabilities: ServerCapabilities;
	serverInfo?: { name?: string; version?: string };
}

export class TinymistClient {
	private nextRequestId = 1;
	private readonly pending = new Map<RequestId, PendingRequest>();
	private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
	private readonly serverRequestHandlers = new Map<string, ServerRequestHandler>();
	private capabilities: ServerCapabilities = {};
	private initialized = false;
	private disposed = false;

	constructor(
		private readonly transport: ClientTransport,
		private readonly logger: Logger,
	) {}

	get serverCapabilities(): Readonly<ServerCapabilities> {
		return this.capabilities;
	}

	get isInitialized(): boolean {
		return this.initialized;
	}

	/**
	 * True when the server advertised the command. Used to keep the UI honest:
	 * a capability that is not advertised is not offered.
	 */
	supportsCommand(command: string): boolean {
		const commands = this.capabilities.executeCommandProvider?.commands;
		return Array.isArray(commands) && commands.includes(command);
	}

	/** True when the server advertised a `textDocument/*` provider. */
	supportsCapability(name: keyof ServerCapabilities): boolean {
		const value = this.capabilities[name];
		return value !== undefined && value !== false && value !== null;
	}

	onNotification(method: string, handler: NotificationHandler): () => void {
		let handlers = this.notificationHandlers.get(method);
		if (!handlers) {
			handlers = new Set();
			this.notificationHandlers.set(method, handlers);
		}
		handlers.add(handler);
		return () => {
			handlers.delete(handler);
		};
	}

	/** Registers a handler for a server-to-client request such as `workspace/configuration`. */
	onServerRequest(method: string, handler: ServerRequestHandler): void {
		this.serverRequestHandlers.set(method, handler);
	}

	/** Feeds one decoded message in. Called by whatever owns the transport. */
	handleMessage(message: IncomingMessage): void {
		if (isResponse(message)) {
			this.handleResponse(message);
			return;
		}
		if (isRequest(message)) {
			void this.handleServerRequest(message);
			return;
		}
		if (isNotification(message)) {
			this.handleNotification(message);
		}
	}

	async initialize(options: InitializeOptions): Promise<InitializeResult> {
		const rootUri = options.rootPath === null ? null : pathToUri(options.rootPath);

		const result = await this.request<InitializeResult>(
			'initialize',
			{
				processId: typeof process === 'undefined' ? null : process.pid,
				clientInfo: { name: 'obsidian-tinymist' },
				locale: 'en',
				rootUri,
				workspaceFolders:
					rootUri === null || options.rootPath === null
						? null
						: [{ uri: rootUri, name: 'vault' }],
				initializationOptions: options.initializationOptions,
				capabilities: CLIENT_CAPABILITIES,
			},
			INITIALIZE_TIMEOUT_MS,
		);

		this.capabilities = result?.capabilities ?? {};
		this.notify('initialized', {});
		this.initialized = true;

		this.logger.info(
			'Tinymist initialized',
			`server=${result?.serverInfo?.name ?? 'tinymist'} version=${result?.serverInfo?.version ?? 'unknown'}`,
		);

		return result;
	}

	/** Runs the `shutdown` request followed by the `exit` notification. */
	async shutdown(): Promise<void> {
		if (!this.initialized) {
			return;
		}
		this.initialized = false;
		try {
			await this.request('shutdown', null, 5_000);
		} finally {
			try {
				this.notify('exit', null);
			} catch {
				// The pipe may already be gone; the process layer handles it.
			}
		}
	}

	request<T = unknown>(
		method: string,
		params: unknown,
		timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
	): Promise<T> {
		if (this.disposed) {
			return Promise.reject(
				new TypstError('lsp-request-failed', 'The Tinymist connection is closed.'),
			);
		}

		const id = this.nextRequestId++;
		return new Promise<T>((resolve, reject) => {
			const timer = window.setTimeout(() => {
				this.pending.delete(id);
				reject(
					new TypstError('lsp-request-failed', `Tinymist did not answer "${method}" in time.`, {
						context: { Request: method },
					}),
				);
			}, timeoutMs);

			this.pending.set(id, {
				method,
				resolve,
				reject,
				timer,
			});

			try {
				this.transport.send({
					jsonrpc: JSONRPC_VERSION,
					id,
					method,
					...(params === undefined ? {} : { params }),
				});
			} catch (error) {
				window.clearTimeout(timer);
				this.pending.delete(id);
				reject(asTypstError(error, 'lsp-request-failed', { Request: method }));
			}
		});
	}

	notify(method: string, params: unknown): void {
		if (this.disposed) {
			return;
		}
		this.transport.send({
			jsonrpc: JSONRPC_VERSION,
			method,
			...(params === undefined ? {} : { params }),
		});
	}

	/** Convenience wrapper for `workspace/executeCommand`. */
	executeCommand<T = unknown>(command: string, args: unknown[], timeoutMs?: number): Promise<T> {
		return this.request<T>('workspace/executeCommand', { command, arguments: args }, timeoutMs);
	}

	/**
	 * Fails every in-flight request and stops accepting new ones. Called when
	 * the process dies so awaiting callers get an error instead of hanging.
	 */
	dispose(reason: string): void {
		this.disposed = true;
		this.initialized = false;
		const error = new TypstError('lsp-request-failed', reason);
		for (const [, pending] of this.pending) {
			window.clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		this.notificationHandlers.clear();
		this.serverRequestHandlers.clear();
	}

	private handleResponse(message: ResponseMessage): void {
		if (message.id === null) {
			return;
		}
		const pending = this.pending.get(message.id);
		if (!pending) {
			this.logger.debug('Response for unknown request', String(message.id));
			return;
		}
		this.pending.delete(message.id);
		window.clearTimeout(pending.timer);

		if (message.error) {
			pending.reject(
				new TypstError('lsp-request-failed', message.error.message, {
					context: { Request: pending.method },
				}),
			);
			return;
		}
		pending.resolve(message.result);
	}

	private handleNotification(message: NotificationMessage): void {
		const handlers = this.notificationHandlers.get(message.method);
		if (!handlers || handlers.size === 0) {
			return;
		}
		for (const handler of handlers) {
			try {
				handler(message.params);
			} catch (error) {
				this.logger.error(`Notification handler for ${message.method} threw`, error);
			}
		}
	}

	private async handleServerRequest(message: RequestMessage): Promise<void> {
		const handler = this.serverRequestHandlers.get(message.method);
		if (!handler) {
			// Method-not-found, per the JSON-RPC spec. Leaving a server request
			// unanswered would wedge Tinymist's own scheduler.
			this.transport.send({
				jsonrpc: JSONRPC_VERSION,
				id: message.id,
				error: { code: -32601, message: `Unhandled request: ${message.method}` },
			});
			return;
		}

		try {
			const result = await handler(message.params);
			this.transport.send({ jsonrpc: JSONRPC_VERSION, id: message.id, result: result ?? null });
		} catch (error) {
			this.transport.send({
				jsonrpc: JSONRPC_VERSION,
				id: message.id,
				error: { code: -32603, message: describeForWire(error) },
			});
		}
	}
}

function describeForWire(error: unknown): string {
	return error instanceof Error ? error.message : 'Client handler failed.';
}

function pathToUri(absolutePath: string): string {
	// Kept local rather than importing the vault-aware helper, so the client
	// stays free of vault concepts.
	const normalized = absolutePath.replace(/\\/g, '/');
	const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
	const encoded = withLeadingSlash
		.split('/')
		.map((segment) => encodeURIComponent(segment))
		.join('/');
	return `file://${encoded}`;
}

/**
 * What this client tells Tinymist it can do.
 *
 * Kept deliberately narrow: advertising a capability the plugin does not
 * implement would make Tinymist send traffic nobody consumes, and would make
 * the UI promise features that do not work.
 */
const CLIENT_CAPABILITIES = {
	general: {
		positionEncodings: ['utf-16'],
	},
	window: {
		// Tinymist uses this to reveal a source location when the preview is
		// clicked, unless `customizedShowDocument` routes it to a notification.
		showDocument: { support: true },
	},
	workspace: {
		configuration: true,
		didChangeConfiguration: { dynamicRegistration: false },
		workspaceFolders: true,
		executeCommand: { dynamicRegistration: false },
	},
	textDocument: {
		synchronization: {
			dynamicRegistration: false,
			willSave: false,
			willSaveWaitUntil: false,
			didSave: true,
		},
		publishDiagnostics: { relatedInformation: false, versionSupport: false },
		completion: {
			dynamicRegistration: false,
			contextSupport: true,
			completionItem: {
				snippetSupport: true,
				documentationFormat: ['markdown', 'plaintext'],
				insertReplaceSupport: false,
			},
		},
		hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
		definition: { dynamicRegistration: false, linkSupport: false },
		references: { dynamicRegistration: false },
		documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
		formatting: { dynamicRegistration: false },
		codeAction: { dynamicRegistration: false },
	},
} as const;
