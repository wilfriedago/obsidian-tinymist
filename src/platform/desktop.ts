import { FileSystemAdapter, Platform, type App } from 'obsidian';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { TypstError } from '../shared/errors';

/**
 * The single place where this plugin touches Node and Electron APIs.
 *
 * Everything above this module is written against the interfaces declared here,
 * which is what keeps a future non-desktop backend (a WASM compiler, say) a
 * matter of supplying a different implementation rather than a rewrite. The
 * manifest sets `isDesktopOnly: true` because of this file.
 *
 * The surface is exactly one capability: spawning the Tinymist executable.
 *
 * There is deliberately **no** filesystem module here. An earlier version used
 * `stat` and `access` to check whether a candidate path was executable, and
 * walked `PATH` by hand. Both are unnecessary: `spawn` resolves a bare command
 * name through `PATH` itself, and running `tinymist probe` validates the
 * binary far better than a permission bit does — it confirms the program is
 * actually Tinymist. Dropping `node:fs` removes the plugin's ability to touch
 * the filesystem outside Obsidian's Vault API altogether, rather than merely
 * limiting it.
 *
 * `spawn` is always called with `shell: false` and an argument array, so no
 * string from a document, a filename, or a setting is ever handed to a shell.
 */

/**
 * Directories added to `PATH` when looking for the executable.
 *
 * A desktop app launched from Finder, the Dock, or a desktop shortcut does not
 * inherit the shell's environment: it gets the system default, which on macOS
 * is `/usr/bin:/bin:/usr/sbin:/sbin`. Homebrew's `/opt/homebrew/bin` is not in
 * it, so a `tinymist` that a terminal finds instantly is invisible to Obsidian.
 *
 * The usual workaround is to run the user's login shell and read `PATH` back
 * out of it. This plugin does not do that: it would mean executing the user's
 * shell profile, which is a much larger capability than launching one known
 * program, and the whole point of the platform layer is that it does not run
 * shells. Adding the handful of directories package managers actually install
 * into gets the same result with no new capability and no surprises.
 *
 * `$HOME` is expanded from the environment rather than `os.homedir()`, to keep
 * `node:child_process` the only Node module in the bundle.
 */
const UNIX_EXTRA_PATH_DIRS = [
	'/opt/homebrew/bin', // Homebrew, Apple silicon
	'/usr/local/bin', // Homebrew on Intel, and most manual installs
	'/opt/local/bin', // MacPorts
	'$HOME/.cargo/bin', // cargo install tinymist-cli
	'$HOME/.local/bin', // pipx, and manual installs
	'/home/linuxbrew/.linuxbrew/bin', // Homebrew on Linux
	'/snap/bin', // Linux snap
	'/var/lib/flatpak/exports/bin', // Linux flatpak
] as const;

const WINDOWS_EXTRA_PATH_DIRS = [
	'$USERPROFILE\\scoop\\shims', // scoop
	'$LOCALAPPDATA\\Microsoft\\WinGet\\Links', // winget
	'$USERPROFILE\\.cargo\\bin', // cargo
] as const;

/**
 * Builds the `PATH` used when spawning, by appending the well-known install
 * directories that are missing from it.
 *
 * Appended, never prepended: anything already on the user's `PATH` keeps
 * priority, so this can only ever find an executable that would otherwise not
 * be found at all. Pure, so the behaviour is testable without a real
 * environment.
 */
export function buildSearchPath(
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform = process.platform,
): string {
	const separator = platform === 'win32' ? ';' : ':';
	const existing = (env['PATH'] ?? env['Path'] ?? '').split(separator).filter(Boolean);

	const seen = new Set(existing);
	const candidates = platform === 'win32' ? WINDOWS_EXTRA_PATH_DIRS : UNIX_EXTRA_PATH_DIRS;

	const extras: string[] = [];
	for (const candidate of candidates) {
		const expanded = expandEnvironmentRefs(candidate, env);
		// An unresolved `$HOME` means the variable is not set; skip rather than
		// adding a literal path with a dollar sign in it.
		if (expanded === null || seen.has(expanded)) {
			continue;
		}
		seen.add(expanded);
		extras.push(expanded);
	}

	return [...existing, ...extras].join(separator);
}

/** Substitutes `$VAR` references, or returns `null` if any is unset. */
function expandEnvironmentRefs(
	template: string,
	env: Record<string, string | undefined>,
): string | null {
	let unresolved = false;
	const expanded = template.replace(/\$([A-Z_]+)/g, (_match, name: string) => {
		const value = env[name];
		if (!value) {
			unresolved = true;
			return '';
		}
		return value;
	});
	return unresolved ? null : expanded;
}

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
	 * Spawns a program directly, without a shell.
	 *
	 * `command` is either an absolute path or a bare name, which the operating
	 * system resolves through `PATH`. Arguments are passed as an array, so no
	 * part of a `.typ` path can be interpreted as shell syntax.
	 */
	spawn(command: string, args: readonly string[], options?: SpawnOptions): SpawnedProcess;
}

/** The reason a spawn failed, as far as the plugin needs to distinguish. */
export type SpawnFailure = 'not-found' | 'not-executable' | 'unknown';

/** Classifies a spawn error so the UI can say something useful about it. */
export function classifySpawnError(error: unknown): SpawnFailure {
	const code = (error as { code?: string } | undefined)?.code;
	switch (code) {
		case 'ENOENT':
			return 'not-found';
		case 'EACCES':
		case 'EPERM':
			return 'not-executable';
		default:
			return 'unknown';
	}
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

	spawn(command: string, args: readonly string[], options: SpawnOptions = {}): SpawnedProcess {
		const env = options.env ?? { ...process.env };

		// `shell` stays false: arguments reach the program verbatim, so a file
		// named `a; rm -rf ~.typ` is just an odd filename and not a command.
		const child: ChildProcessWithoutNullStreams = spawn(command, [...args], {
			cwd: options.cwd,
			env: { ...env, PATH: buildSearchPath(env) },
			shell: false,
			windowsHide: true,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		return child;
	}
}
