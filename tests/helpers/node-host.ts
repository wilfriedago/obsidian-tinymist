import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	buildSearchPath,
	type DesktopHost,
	type SpawnOptions,
	type SpawnedProcess,
} from '../../src/platform/desktop';

/**
 * A `DesktopHost` backed by real Node APIs, for integration tests.
 *
 * The production implementation lives behind `resolveDesktopHost(app)`, which
 * needs a live Obsidian `App`. This mirrors its behaviour without one.
 */
export class NodeTestHost implements DesktopHost {
	constructor(readonly vaultBasePath: string) {}

	spawn(command: string, args: readonly string[], options: SpawnOptions = {}): SpawnedProcess {
		const env = options.env ?? { ...process.env };
		// Mirrors NodeDesktopHost exactly, including the PATH augmentation that
		// makes a GUI-launched Obsidian able to find Tinymist at all. A test
		// host that skipped it would pass while production failed.
		return spawn(command, [...args], {
			cwd: options.cwd,
			env: { ...env, PATH: buildSearchPath(env) },
			shell: false,
			windowsHide: true,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
	}

	/**
	 * Temporary-directory helpers for tests only.
	 *
	 * Deliberately *not* on `DesktopHost`: the shipped plugin imports no
	 * filesystem module at all, and keeping these out of the interface is what
	 * guarantees it cannot acquire one by accident.
	 */
	async createTempDirectory(prefix: string): Promise<string> {
		return await mkdtemp(join(tmpdir(), prefix));
	}

	async removeDirectory(path: string): Promise<void> {
		await rm(path, { recursive: true, force: true });
	}
}
