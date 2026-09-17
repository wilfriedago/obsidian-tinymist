import { FileSystemAdapter, Platform, type App } from 'obsidian';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, constants, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

import { TypstError } from '../shared/errors';

/**
 * The single place where this plugin touches Node and Electron APIs.
 *
 * Everything above this module is written against the interfaces declared here,
 * which is what keeps a future non-desktop backend (a WASM compiler, say) a
 * matter of supplying a different implementation rather than a rewrite. The
 * manifest sets `isDesktopOnly: true` because of this file.
 *
 * The surface is deliberately as small as launching an external program allows:
 *
 * - `node:child_process` is used only to `spawn` the configured Tinymist
 *   executable, always with `shell: false` and an argument array. No string is
 *   ever handed to a shell, so nothing in a document, a filename, or a setting
 *   can be interpreted as a command.
 * - `node:fs/promises` is used only to *read metadata* — `stat` and `access` —
 *   when checking whether a candidate path is an executable file. This module
 *   has no way to read file contents, and no way to write or delete anything.
 *   Every byte the plugin reads or writes in the vault goes through Obsidian's
 *   Vault API instead.
 */

/** A spawned child process, narrowed to what the plugin actually uses. */
export interface SpawnedProcess {
	readonly pid?: number | undefined;
	readonly stdin: NodeJS.WritableStream;
	readonly stdout: NodeJS.ReadableStream;
	readonly stderr: NodeJS.ReadableStream;
	kill(signal?: NodeJS.Signals): boolean;
	on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
	on(event: 'error', listener: (error: Error) => void): void;
}

export interface SpawnOptions {
	readonly cwd?: string;
	readonly env?: Record<string, string>;
}

/** Desktop capabilities the rest of the plugin depends on. */
export interface DesktopHost {
	/** Absolute path of the vault directory. */
	readonly vaultBasePath: string;
	/**
	 * Spawns a program directly, without a shell. Arguments are passed as an
	 * array so that no part of a `.typ` path can be interpreted as shell syntax.
	 */
	spawn(executable: string, args: readonly string[], options?: SpawnOptions): SpawnedProcess;
	/** Resolves to `true` when the path exists and is an executable file. */
	isExecutableFile(path: string): Promise<boolean>;
	/** Looks an executable name up on `PATH`, returning the first hit. */
	findOnPath(executableName: string): Promise<string | null>;
}

/**
 * Resolves the desktop host, or throws when the plugin is running somewhere it
 * cannot work (mobile, or a vault that is not filesystem-backed).
 */
export function resolveDesktopHost(app: App): DesktopHost {
	if (!Platform.isDesktopApp) {
		throw new TypstError(
			'platform-unsupported',
			'Tinymist runs as a native executable, which Obsidian mobile cannot launch.',
		);
	}

	const adapter = app.vault.adapter;
	if (!(adapter instanceof FileSystemAdapter)) {
		throw new TypstError(
			'platform-unsupported',
			'This vault is not stored on the filesystem, so Tinymist cannot read its files.',
		);
	}

	return new NodeDesktopHost(adapter.getBasePath());
}

class NodeDesktopHost implements DesktopHost {
	constructor(readonly vaultBasePath: string) {}

	spawn(executable: string, args: readonly string[], options: SpawnOptions = {}): SpawnedProcess {
		// `shell` stays false: arguments reach the program verbatim, so a file
		// named `a; rm -rf ~.typ` is just an odd filename and not a command.
		const child: ChildProcessWithoutNullStreams = spawn(executable, [...args], {
			cwd: options.cwd,
			env: options.env ?? { ...process.env },
			shell: false,
			windowsHide: true,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		return child;
	}

	async isExecutableFile(path: string): Promise<boolean> {
		try {
			const info = await stat(path);
			if (!info.isFile()) {
				return false;
			}
			await access(path, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	}

	async findOnPath(executableName: string): Promise<string | null> {
		const rawPath = process.env['PATH'];
		if (!rawPath) {
			return null;
		}

		// On Windows an executable is found by appending one of PATHEXT.
		const suffixes =
			process.platform === 'win32'
				? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
				: [''];

		for (const directory of rawPath.split(delimiter)) {
			if (!directory) {
				continue;
			}
			for (const suffix of suffixes) {
				const candidate = join(directory, `${executableName}${suffix}`);
				if (await this.isExecutableFile(candidate)) {
					return candidate;
				}
			}
		}

		return null;
	}
}
