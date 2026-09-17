import type { DesktopHost, SpawnedProcess } from '../../platform/desktop';
import { TypstError, describeUnknownError } from '../../shared/errors';
import type { Logger } from '../../shared/logging';
import { MessageDecoder, encodeMessage, type IncomingMessage } from './protocol';

/**
 * Owns one `tinymist lsp` child process and its stdio framing.
 *
 * Responsibilities stop at the byte level: spawn it, frame messages on and off
 * its pipes, notice when it dies, and guarantee it is gone afterwards. It knows
 * nothing about LSP semantics — that is {@link TinymistClient}'s job.
 */

export type ProcessExitReason =
	| { kind: 'requested' }
	| { kind: 'crashed'; code: number | null; signal: NodeJS.Signals | null };

export interface TinymistProcessHandlers {
	onMessage(message: IncomingMessage): void;
	onExit(reason: ProcessExitReason): void;
}

export interface TinymistProcessOptions {
	readonly executablePath: string;
	readonly cwd: string;
	/** Extra arguments appended after `lsp`. Empty in normal operation. */
	readonly extraArgs?: readonly string[];
}

/** How long a graceful stop is given before the process is killed. */
export const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 3_000;
/** How long `SIGTERM` is given before `SIGKILL`. */
export const SIGTERM_TIMEOUT_MS = 2_000;
/** How many stderr bytes to retain for diagnosing a failed start. */
const STDERR_RETAIN_BYTES = 8_192;

export class TinymistProcess {
	private child: SpawnedProcess | null = null;
	private readonly decoder = new MessageDecoder();
	private stderrTail = '';
	private exited = false;
	private stopRequested = false;

	constructor(
		private readonly host: DesktopHost,
		private readonly logger: Logger,
		private readonly options: TinymistProcessOptions,
		private readonly handlers: TinymistProcessHandlers,
	) {}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	get isRunning(): boolean {
		return this.child !== null && !this.exited;
	}

	/** Most recent stderr output, for error reporting. Never contains document text. */
	get recentStderr(): string {
		return this.stderrTail.trim();
	}

	/**
	 * Spawns the process. Throws a categorized error if the spawn itself fails;
	 * a process that starts and then dies is reported through `onExit`.
	 */
	start(): void {
		if (this.child) {
			throw new TypstError('tinymist-start-failed', 'The Tinymist process is already running.');
		}

		const args = ['lsp', ...(this.options.extraArgs ?? [])];
		this.logger.info('Starting Tinymist', `args=${JSON.stringify(args)}`);

		let child: SpawnedProcess;
		try {
			child = this.host.spawn(this.options.executablePath, args, {
				cwd: this.options.cwd,
				// `RUST_BACKTRACE=1` makes a panic report a location without
				// requiring the debug build the user does not have.
				env: { ...process.env, RUST_BACKTRACE: '1' },
			});
		} catch (error) {
			throw new TypstError('tinymist-start-failed', describeUnknownError(error), {
				context: { Executable: this.options.executablePath },
				cause: error,
			});
		}

		this.child = child;
		this.exited = false;
		this.stopRequested = false;
		this.decoder.reset();
		this.stderrTail = '';

		child.stdout.on('data', (chunk: Buffer) => {
			for (const message of this.decoder.append(chunk)) {
				try {
					this.handlers.onMessage(message);
				} catch (error) {
					this.logger.error('Message handler threw', error);
				}
			}
		});

		child.stderr.on('data', (chunk: Buffer) => {
			this.retainStderr(chunk.toString('utf8'));
		});

		child.on('error', (error: Error) => {
			this.logger.error('Tinymist process error', error);
			this.finish({ kind: 'crashed', code: null, signal: null });
		});

		child.on('exit', (code, signal) => {
			this.logger.info('Tinymist exited', `code=${code} signal=${signal}`);
			this.finish(
				this.stopRequested ? { kind: 'requested' } : { kind: 'crashed', code, signal },
			);
		});
	}

	/** Writes a framed message to the process's stdin. */
	send(message: Parameters<typeof encodeMessage>[0]): void {
		const child = this.child;
		if (!child || this.exited) {
			throw new TypstError('lsp-request-failed', 'Tinymist is not running.');
		}
		child.stdin.write(encodeMessage(message));
	}

	/**
	 * Ends the process. `beforeSignal` is the caller's chance to run the LSP
	 * `shutdown`/`exit` handshake; if the process has not exited by
	 * {@link GRACEFUL_SHUTDOWN_TIMEOUT_MS}, it is signalled, and if it survives
	 * `SIGTERM` it is killed. This ordering is what keeps orphans impossible.
	 */
	async stop(beforeSignal?: () => Promise<void>): Promise<void> {
		const child = this.child;
		if (!child || this.exited) {
			this.child = null;
			return;
		}

		this.stopRequested = true;

		if (beforeSignal) {
			try {
				await withTimeout(beforeSignal(), GRACEFUL_SHUTDOWN_TIMEOUT_MS);
			} catch (error) {
				this.logger.warn('Graceful shutdown handshake failed', error);
			}
		}

		if (this.exited) {
			this.child = null;
			return;
		}

		this.logger.debug('Sending SIGTERM to Tinymist', `pid=${child.pid}`);
		child.kill('SIGTERM');

		const terminated = await this.waitForExit(SIGTERM_TIMEOUT_MS);
		if (!terminated) {
			this.logger.warn('Tinymist ignored SIGTERM; sending SIGKILL', `pid=${child.pid}`);
			child.kill('SIGKILL');
			await this.waitForExit(SIGTERM_TIMEOUT_MS);
		}

		this.child = null;
	}

	/**
	 * Kills immediately with no handshake. Used from `onunload`, where Obsidian
	 * does not wait for us and a lingering process would outlive the app.
	 */
	killNow(): void {
		const child = this.child;
		if (!child || this.exited) {
			return;
		}
		this.stopRequested = true;
		try {
			child.kill('SIGKILL');
		} catch (error) {
			this.logger.error('Failed to kill Tinymist', error);
		}
		this.child = null;
	}

	private finish(reason: ProcessExitReason): void {
		if (this.exited) {
			return;
		}
		this.exited = true;
		this.handlers.onExit(reason);
	}

	private waitForExit(timeoutMs: number): Promise<boolean> {
		if (this.exited) {
			return Promise.resolve(true);
		}
		return new Promise((resolve) => {
			const timer = window.setTimeout(() => resolve(this.exited), timeoutMs);
			const poll = window.setInterval(() => {
				if (this.exited) {
					window.clearInterval(poll);
					window.clearTimeout(timer);
					resolve(true);
				}
			}, 25);
			// Both handles are cleared on whichever path resolves first.
			window.setTimeout(() => window.clearInterval(poll), timeoutMs + 50);
		});
	}

	private retainStderr(text: string): void {
		this.stderrTail = (this.stderrTail + text).slice(-STDERR_RETAIN_BYTES);
	}
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
	return Promise.race([
		promise,
		new Promise<undefined>((resolve) => window.setTimeout(() => resolve(undefined), timeoutMs)),
	]);
}
