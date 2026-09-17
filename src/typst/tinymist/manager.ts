import type { DesktopHost } from '../../platform/desktop';
import { TypstError, asTypstError } from '../../shared/errors';
import type { Logger } from '../../shared/logging';
import { TinymistClient } from './client';
import {
	buildInitializationOptions,
	resolveExecutable,
	resolveWorkspaceRoot,
	type ResolvedExecutable,
	type TinymistInitOptions,
} from './config';
import { TinymistProcess, type ProcessExitReason } from './process';
import type { IncomingMessage } from './protocol';
import {
	MINIMUM_TINYMIST_VERSION,
	parseTypstVersionFromBanner,
	parseVersionOutput,
	satisfiesMinimum,
	type TinymistVersion,
} from './version';

/**
 * The plugin's single point of contact with Tinymist.
 *
 * Everything above this line asks the manager for a ready client and listens
 * for state changes; nothing above it knows that a child process exists. That
 * boundary is what makes Tinymist replaceable.
 */

export type TinymistState =
	| { readonly kind: 'stopped' }
	| { readonly kind: 'starting' }
	| { readonly kind: 'ready'; readonly executable: ResolvedExecutable; readonly version: TinymistVersion | null }
	| { readonly kind: 'failed'; readonly error: TypstError }
	| { readonly kind: 'crashed'; readonly error: TypstError };

export type TinymistStateListener = (state: TinymistState) => void;

/** How long `tinymist -V` is given before we call the executable unusable. */
const VERSION_PROBE_TIMEOUT_MS = 10_000;
/** Restarts are backed off so a binary that dies instantly cannot spin. */
const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000] as const;
/** Consecutive crashes after which we stop restarting on our own. */
const MAX_AUTOMATIC_RESTARTS = RESTART_BACKOFF_MS.length;

export interface TinymistManagerOptions {
	readonly host: DesktopHost;
	readonly logger: Logger;
	/** Read fresh on every start, so settings changes apply on restart. */
	getInitOptions(): TinymistInitOptions;
	/** Called once a client is initialized, to install notification handlers. */
	onClientReady(client: TinymistClient): void;
	/** Called before a client goes away, to tear down anything bound to it. */
	onClientGone(): void;
}

export class TinymistManager {
	private state: TinymistState = { kind: 'stopped' };
	private readonly listeners = new Set<TinymistStateListener>();

	private process: TinymistProcess | null = null;
	private client: TinymistClient | null = null;
	private startPromise: Promise<TinymistClient> | null = null;

	private consecutiveCrashes = 0;
	private restartTimer: number | null = null;
	private unloaded = false;

	private detectedVersion: TinymistVersion | null = null;
	private detectedTypstVersion: string | null = null;

	constructor(private readonly options: TinymistManagerOptions) {}

	getState(): TinymistState {
		return this.state;
	}

	getVersion(): TinymistVersion | null {
		return this.detectedVersion;
	}

	getTypstVersion(): string | null {
		return this.detectedTypstVersion;
	}

	/** The live client, or `null` when Tinymist is not ready. */
	getClient(): TinymistClient | null {
		return this.state.kind === 'ready' ? this.client : null;
	}

	onStateChange(listener: TinymistStateListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Returns a ready client, starting Tinymist if needed. Concurrent callers
	 * share one start; there is never a second process racing the first.
	 */
	async ensureStarted(): Promise<TinymistClient> {
		if (this.unloaded) {
			throw new TypstError('tinymist-start-failed', 'The plugin is unloading.');
		}
		if (this.state.kind === 'ready' && this.client) {
			return this.client;
		}
		if (this.startPromise) {
			return await this.startPromise;
		}

		this.startPromise = this.start().finally(() => {
			this.startPromise = null;
		});
		return await this.startPromise;
	}

	/** Stops and starts again, resetting the crash backoff. */
	async restart(): Promise<void> {
		this.cancelScheduledRestart();
		this.consecutiveCrashes = 0;
		await this.stop();
		if (!this.unloaded) {
			await this.ensureStarted();
		}
	}

	/** Graceful stop: LSP shutdown handshake, then signals if that is ignored. */
	async stop(): Promise<void> {
		this.cancelScheduledRestart();

		const client = this.client;
		const process = this.process;

		this.options.onClientGone();
		this.client = null;
		this.process = null;

		if (client) {
			client.dispose('Tinymist was stopped.');
		}

		if (process) {
			await process.stop(async () => {
				if (client) {
					await client.shutdown();
				}
			});
		}

		this.setState({ kind: 'stopped' });
	}

	/**
	 * Synchronous teardown for `Plugin.onunload`, which does not await. Anything
	 * still running is killed outright so no Tinymist outlives Obsidian.
	 */
	unload(): void {
		this.unloaded = true;
		this.cancelScheduledRestart();
		this.listeners.clear();

		const client = this.client;
		const process = this.process;
		this.client = null;
		this.process = null;

		client?.dispose('The plugin was unloaded.');
		process?.killNow();
		this.state = { kind: 'stopped' };
	}

	/** Runs `tinymist -V` against a path without starting a server. */
	async probeVersion(executablePath: string): Promise<{
		version: TinymistVersion | null;
		typstVersion: string | null;
	}> {
		const short = await this.runForOutput(executablePath, ['-V']);
		const version = parseVersionOutput(short);

		let typstVersion: string | null = null;
		try {
			typstVersion = parseTypstVersionFromBanner(
				await this.runForOutput(executablePath, ['--version']),
			);
		} catch {
			// The banner is a nicety; its absence is not an error.
		}

		return { version, typstVersion };
	}

	private async start(): Promise<TinymistClient> {
		this.setState({ kind: 'starting' });

		const initOptions = this.options.getInitOptions();

		let executable: ResolvedExecutable;
		try {
			executable = await resolveExecutable(this.options.host, initOptions.executablePath);
		} catch (error) {
			throw this.fail(asTypstError(error, 'tinymist-not-found'));
		}

		// A binary that cannot answer `probe` is not a Tinymist we can drive.
		try {
			await this.runForOutput(executable.path, ['probe']);
		} catch (error) {
			throw this.fail(
				asTypstError(error, 'tinymist-invalid-executable', {
					'Configured executable': executable.path,
				}),
			);
		}

		const probed = await this.probeVersion(executable.path).catch(() => ({
			version: null,
			typstVersion: null,
		}));
		this.detectedVersion = probed.version;
		this.detectedTypstVersion = probed.typstVersion;

		if (probed.version && !satisfiesMinimum(probed.version)) {
			throw this.fail(
				new TypstError(
					'tinymist-invalid-executable',
					`Tinymist ${probed.version.raw} is older than the ${MINIMUM_TINYMIST_VERSION.raw} this plugin requires.`,
					{ context: { Executable: executable.path } },
				),
			);
		}

		const process = new TinymistProcess(
			this.options.host,
			this.options.logger.child('process'),
			{
				executablePath: executable.path,
				// Running in the vault keeps relative paths in Tinymist's own
				// logs meaningful without granting access to anything new.
				cwd: initOptions.vaultBasePath,
			},
			{
				onMessage: (message: IncomingMessage) => this.client?.handleMessage(message),
				onExit: (reason) => this.handleProcessExit(reason),
			},
		);

		const client = new TinymistClient(
			{ send: (message) => process.send(message) },
			this.options.logger.child('lsp'),
		);

		this.process = process;
		this.client = client;

		try {
			process.start();
		} catch (error) {
			throw this.fail(asTypstError(error, 'tinymist-start-failed'));
		}

		// Tinymist asks the client for its configuration during startup. An
		// unanswered request would leave it waiting forever.
		client.onServerRequest('workspace/configuration', (params) =>
			answerConfiguration(params, buildInitializationOptions(this.options.getInitOptions())),
		);
		client.onServerRequest('window/workDoneProgress/create', () => null);
		client.onServerRequest('client/registerCapability', () => null);
		client.onServerRequest('client/unregisterCapability', () => null);

		try {
			await client.initialize({
				rootPath: resolveWorkspaceRoot(initOptions),
				initializationOptions: buildInitializationOptions(initOptions),
			});
		} catch (error) {
			const failure = asTypstError(error, 'lsp-init-failed', {
				Executable: executable.path,
				...(process.recentStderr ? { 'Server output': truncate(process.recentStderr) } : {}),
			});
			await this.stop();
			throw this.fail(failure);
		}

		this.consecutiveCrashes = 0;
		this.setState({ kind: 'ready', executable, version: probed.version });
		this.options.onClientReady(client);

		return client;
	}

	private handleProcessExit(reason: ProcessExitReason): void {
		if (this.unloaded || reason.kind === 'requested') {
			return;
		}

		const stderr = this.process?.recentStderr ?? '';
		this.options.onClientGone();
		this.client?.dispose('Tinymist stopped unexpectedly.');
		this.client = null;
		this.process = null;

		const error = new TypstError(
			'tinymist-crashed',
			reason.signal
				? `The process was terminated by ${reason.signal}.`
				: `The process exited with code ${reason.code ?? 'unknown'}.`,
			{ context: stderr ? { 'Server output': truncate(stderr) } : {} },
		);

		this.consecutiveCrashes += 1;
		this.setState({ kind: 'crashed', error });
		this.options.logger.error('Tinymist crashed', error.message);

		this.scheduleRestart();
	}

	private scheduleRestart(): void {
		if (this.consecutiveCrashes > MAX_AUTOMATIC_RESTARTS) {
			this.options.logger.warn(
				'Not restarting Tinymist automatically',
				`crashes=${this.consecutiveCrashes}`,
			);
			return;
		}

		const delay = RESTART_BACKOFF_MS[this.consecutiveCrashes - 1] ?? 10_000;
		this.options.logger.info('Scheduling Tinymist restart', `delayMs=${delay}`);

		this.restartTimer = window.setTimeout(() => {
			this.restartTimer = null;
			if (this.unloaded) {
				return;
			}
			void this.ensureStarted().catch((error: unknown) => {
				this.options.logger.error('Automatic restart failed', error);
			});
		}, delay);
	}

	private cancelScheduledRestart(): void {
		if (this.restartTimer !== null) {
			window.clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
	}

	private fail(error: TypstError): TypstError {
		this.setState({ kind: 'failed', error });
		this.options.logger.error('Tinymist failed to start', error.message);
		return error;
	}

	private setState(state: TinymistState): void {
		this.state = state;
		for (const listener of this.listeners) {
			try {
				listener(state);
			} catch (error) {
				this.options.logger.error('State listener threw', error);
			}
		}
	}

	/** Spawns the executable, collects stdout, and resolves when it exits. */
	private runForOutput(executablePath: string, args: readonly string[]): Promise<string> {
		return new Promise((resolve, reject) => {
			let child;
			try {
				child = this.options.host.spawn(executablePath, args);
			} catch (error) {
				reject(asTypstError(error, 'tinymist-invalid-executable'));
				return;
			}

			let stdout = '';
			let stderr = '';
			let settled = false;

			const timer = window.setTimeout(() => {
				if (settled) {
					return;
				}
				settled = true;
				child.kill('SIGKILL');
				reject(
					new TypstError(
						'tinymist-invalid-executable',
						`The executable did not respond to "${args.join(' ')}" within ${VERSION_PROBE_TIMEOUT_MS / 1000}s.`,
					),
				);
			}, VERSION_PROBE_TIMEOUT_MS);

			child.stdout.on('data', (chunk: Buffer) => {
				stdout += chunk.toString('utf8');
			});
			child.stderr.on('data', (chunk: Buffer) => {
				stderr += chunk.toString('utf8');
			});

			child.on('error', (error: Error) => {
				if (settled) {
					return;
				}
				settled = true;
				window.clearTimeout(timer);
				reject(asTypstError(error, 'tinymist-invalid-executable'));
			});

			child.on('exit', (code) => {
				if (settled) {
					return;
				}
				settled = true;
				window.clearTimeout(timer);
				if (code === 0) {
					// Some subcommands print the banner on stderr.
					resolve(stdout.length > 0 ? stdout : stderr);
				} else {
					reject(
						new TypstError(
							'tinymist-invalid-executable',
							`The executable exited with code ${code ?? 'unknown'}.`,
							{ context: stderr.trim() ? { Output: truncate(stderr) } : {} },
						),
					);
				}
			});
		});
	}
}

/**
 * Answers `workspace/configuration`. Tinymist asks for the `tinymist` section
 * (and sometimes for an unnamed section); anything else gets `null`.
 */
export function answerConfiguration(
	params: unknown,
	config: Record<string, unknown>,
): (Record<string, unknown> | null)[] {
	const items = (params as { items?: { section?: string }[] } | undefined)?.items ?? [];
	return items.map((item) => {
		if (!item.section || item.section === 'tinymist') {
			return config;
		}
		return null;
	});
}

function truncate(text: string, limit = 400): string {
	const trimmed = text.trim();
	return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}
