import { TypstError, asTypstError } from '../shared/errors';
import type { Logger } from '../shared/logging';
import type { VaultPath } from '../shared/paths';
import type { TinymistClient } from '../typst/tinymist/client';
import { buildPreviewArgs, type InvertColorsStrategy } from '../typst/tinymist/config';
import {
	TINYMIST_COMMAND,
	type PreviewScrollRequest,
	type StartPreviewResult,
} from '../typst/tinymist/protocol';

/**
 * Owns Tinymist's preview tasks.
 *
 * The preview is a server Tinymist runs inside its own process, reached over
 * HTTP and a websocket. This controller starts one task per previewed document,
 * remembers its port, and guarantees the task is killed when the view closes —
 * the view itself only ever sees a URL.
 */

export interface PreviewSession {
	readonly taskId: string;
	readonly vaultPath: VaultPath;
	/** The URL an iframe should load. Always loopback. */
	readonly url: string;
	readonly isPrimary: boolean;
	/** The strategy this task was started with, so a change can be detected. */
	readonly invertColors: InvertColorsStrategy;
}

export interface PreviewOptions {
	readonly refreshOnType: boolean;
	/** Render only the visible pages, rather than the whole document. */
	readonly partialRendering: boolean;
	/** How Tinymist should invert the rendered page's colours. */
	readonly invertColors: InvertColorsStrategy;
}

export class PreviewController {
	private readonly sessions = new Map<VaultPath, PreviewSession>();
	/** Guards against two opens of the same document racing into two tasks. */
	private readonly starting = new Map<VaultPath, Promise<PreviewSession>>();

	constructor(private readonly logger: Logger) {}

	getSession(vaultPath: VaultPath): PreviewSession | null {
		return this.sessions.get(vaultPath) ?? null;
	}

	get activeCount(): number {
		return this.sessions.size;
	}

	/** Starts a preview task for a document, or returns the running one. */
	async start(
		client: TinymistClient,
		vaultPath: VaultPath,
		absolutePath: string,
		options: PreviewOptions,
	): Promise<PreviewSession> {
		const existing = this.sessions.get(vaultPath);
		if (existing) {
			if (existing.invertColors === options.invertColors) {
				return existing;
			}
			// Colour inversion is fixed when the task starts: the strategy is a
			// CLI argument, and the preview frontend only exposes it as a local
			// keypress we cannot reach across the iframe's origin. Changing the
			// theme therefore means replacing the task.
			this.logger.info(
				'Restarting preview for a theme change',
				`task=${existing.taskId} ${existing.invertColors} -> ${options.invertColors}`,
			);
			await this.stop(client, vaultPath);
		}

		const pending = this.starting.get(vaultPath);
		if (pending) {
			return await pending;
		}

		const run = this.startTask(client, vaultPath, absolutePath, options).finally(() => {
			this.starting.delete(vaultPath);
		});
		this.starting.set(vaultPath, run);
		return await run;
	}

	private async startTask(
		client: TinymistClient,
		vaultPath: VaultPath,
		absolutePath: string,
		options: PreviewOptions,
	): Promise<PreviewSession> {
		if (!client.supportsCommand(TINYMIST_COMMAND.startPreview)) {
			throw new TypstError(
				'preview-unavailable',
				'This Tinymist build does not provide the preview command.',
			);
		}

		const taskId = taskIdFor(vaultPath);
		// Tinymist reuses the LSP's own compiler for the first ("primary")
		// preview and spawns an extra compiler for each additional one, so only
		// the first task may claim primary.
		const notPrimary = this.sessions.size > 0;

		const args = buildPreviewArgs({
			taskId,
			entryAbsolutePath: absolutePath,
			notPrimary,
			invertColors: options.invertColors,
			refreshOnType: options.refreshOnType,
			partialRendering: options.partialRendering,
		});

		let result: StartPreviewResult;
		try {
			result = await client.executeCommand<StartPreviewResult>(
				TINYMIST_COMMAND.startPreview,
				[args],
				60_000,
			);
		} catch (error) {
			throw asTypstError(error, 'preview-unavailable', { Document: vaultPath });
		}

		const port = result.staticServerPort;
		if (typeof port !== 'number') {
			throw new TypstError(
				'preview-unavailable',
				'Tinymist started a preview but reported no server port.',
				{ context: { Document: vaultPath } },
			);
		}

		const session: PreviewSession = {
			taskId,
			vaultPath,
			// Loopback only. The preview frontend derives its websocket address
			// from `window.location`, so this one URL wires up both channels.
			url: `http://127.0.0.1:${port}/`,
			isPrimary: result.isPrimary ?? !notPrimary,
			invertColors: options.invertColors,
		};

		this.sessions.set(vaultPath, session);
		this.logger.info('Preview started', `task=${taskId} primary=${session.isPrimary}`);
		return session;
	}

	/** Ends one document's preview. Safe to call when none is running. */
	async stop(client: TinymistClient | null, vaultPath: VaultPath): Promise<void> {
		const session = this.sessions.get(vaultPath);
		if (!session) {
			return;
		}
		this.sessions.delete(vaultPath);

		if (!client) {
			return;
		}
		try {
			await client.executeCommand(TINYMIST_COMMAND.killPreview, [session.taskId], 10_000);
			this.logger.info('Preview stopped', `task=${session.taskId}`);
		} catch (error) {
			// The task may already be gone, e.g. after a crash. Not worth
			// interrupting the user over.
			this.logger.debug('Killing preview failed', error);
		}
	}

	async stopAll(client: TinymistClient | null): Promise<void> {
		await Promise.all([...this.sessions.keys()].map((path) => this.stop(client, path)));
	}

	/** Drops bookkeeping without talking to a server that is already gone. */
	forgetAll(): void {
		this.sessions.clear();
		this.starting.clear();
	}

	/**
	 * Source to preview: asks the preview to scroll to the cursor's location.
	 * Tinymist owns the span mapping; the plugin only reports where the caret is.
	 */
	async scrollToSource(
		client: TinymistClient,
		vaultPath: VaultPath,
		absolutePath: string,
		line: number,
		character: number,
	): Promise<void> {
		const session = this.sessions.get(vaultPath);
		if (!session || !client.supportsCommand(TINYMIST_COMMAND.scrollPreview)) {
			return;
		}

		const request: PreviewScrollRequest = {
			event: 'panelScrollTo',
			filepath: absolutePath,
			line,
			character,
		};

		try {
			await client.executeCommand(
				TINYMIST_COMMAND.scrollPreview,
				[session.taskId, request],
				5_000,
			);
		} catch (error) {
			this.logger.debug('Scrolling the preview failed', error);
		}
	}

	/** Finds which document a task id belongs to, for dispose notifications. */
	vaultPathForTask(taskId: string): VaultPath | null {
		for (const session of this.sessions.values()) {
			if (session.taskId === taskId) {
				return session.vaultPath;
			}
		}
		return null;
	}

	/** Forgets a task Tinymist has told us is gone. */
	forgetTask(taskId: string): void {
		const vaultPath = this.vaultPathForTask(taskId);
		if (vaultPath !== null) {
			this.sessions.delete(vaultPath);
		}
	}
}

/**
 * A stable, filesystem-safe task id derived from the document's vault path.
 *
 * Vault paths contain slashes, spaces, and non-ASCII characters; Tinymist takes
 * the id as a CLI argument and reserves `primary`. Hashing the full path keeps
 * documents with the same basename in different folders distinct.
 */
export function taskIdFor(vaultPath: VaultPath): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < vaultPath.length; index += 1) {
		hash ^= vaultPath.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `obsidian-${hash.toString(16).padStart(8, '0')}`;
}
