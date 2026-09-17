import { spawn } from 'node:child_process';
import { access, constants, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import type { DesktopHost, SpawnOptions, SpawnedProcess } from '../../src/platform/desktop';

/**
 * A `DesktopHost` backed by real Node APIs, for integration tests.
 *
 * The production implementation lives behind `resolveDesktopHost(app)`, which
 * needs a live Obsidian `App`. This mirrors its behaviour without one.
 */
export class NodeTestHost implements DesktopHost {
	constructor(readonly vaultBasePath: string) {}

	spawn(executable: string, args: readonly string[], options: SpawnOptions = {}): SpawnedProcess {
		return spawn(executable, [...args], {
			cwd: options.cwd,
			env: options.env ?? { ...process.env },
			shell: false,
			windowsHide: true,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
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
		for (const directory of rawPath.split(delimiter)) {
			if (!directory) {
				continue;
			}
			const candidate = join(directory, executableName);
			if (await this.isExecutableFile(candidate)) {
				return candidate;
			}
		}
		return null;
	}

	/**
	 * Temporary-directory helpers for tests only.
	 *
	 * These are deliberately *not* on `DesktopHost`: the shipped plugin has no
	 * ability to create or delete directories, and keeping these out of the
	 * interface is what guarantees that.
	 */
	async createTempDirectory(prefix: string): Promise<string> {
		return await mkdtemp(join(tmpdir(), prefix));
	}

	async removeDirectory(path: string): Promise<void> {
		await rm(path, { recursive: true, force: true });
	}
}
