#!/usr/bin/env node
/**
 * Points git at `.githooks/`, so commit subjects are checked as they are
 * written rather than after they reach CI. Run by `pnpm install`, through the
 * `prepare` script.
 *
 * A setting, not a copy into `.git/hooks`: the hooks stay versioned, update
 * with a pull, and apply to every worktree of the clone.
 *
 * Never fails an install, and never takes over a hooks path you chose: if
 * `core.hooksPath` already points somewhere else, it says so and leaves it.
 * Skipped in CI, which runs the same check itself.
 */
import { execFileSync } from 'node:child_process';

const HOOKS = '.githooks';

const git = (...args) =>
	execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function run() {
	if (process.env.CI) {
		return;
	}
	try {
		git('rev-parse', '--git-dir');
	} catch {
		// Not a clone, e.g. an unpacked tarball, or git is not installed.
		return;
	}

	let current = '';
	try {
		current = git('config', '--get', 'core.hooksPath');
	} catch {
		// Unset, which is the usual case.
	}

	if (current === HOOKS) {
		return;
	}
	if (current !== '') {
		console.log(
			`git hooks: core.hooksPath is already "${current}", so this repository's hooks in ${HOOKS}/ are not enabled.\n` +
				`  To use them: git config core.hooksPath ${HOOKS}`,
		);
		return;
	}

	git('config', 'core.hooksPath', HOOKS);
	console.log(`git hooks: enabled from ${HOOKS}/ (commit subjects are checked for release-please).`);
}

try {
	run();
} catch (error) {
	console.log(`git hooks: not enabled (${error instanceof Error ? error.message : String(error)}).`);
}
