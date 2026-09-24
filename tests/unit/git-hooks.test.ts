import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The commit-msg and pre-push hooks, and their installer, run for real in a
 * throwaway repository. Nothing here touches this clone's own git config.
 */

const ROOT = resolve(__dirname, '../..');

let repo = '';

afterEach(() => {
	if (repo) rmSync(repo, { recursive: true, force: true });
	repo = '';
});

// No CI variable, so the installer behaves as it does on a laptop.
const env = { ...process.env, CI: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function git(...args: string[]): string {
	return execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
}

/** A clone-alike with the hooks, their script, and the installer in place. */
function setup(): void {
	repo = mkdtempSync(join(tmpdir(), 'git-hooks-'));
	git('init', '-q', '-b', 'main');
	git('config', 'user.name', 'Test');
	git('config', 'user.email', 'test@example.com');
	cpSync(join(ROOT, '.githooks'), join(repo, '.githooks'), { recursive: true });
	mkdirSync(join(repo, 'scripts'));
	for (const script of ['check-commit-subject.mjs', 'install-git-hooks.mjs']) {
		cpSync(join(ROOT, 'scripts', script), join(repo, 'scripts', script));
	}
}

function install(extraEnv: Record<string, string> = {}): string {
	return execFileSync('node', ['scripts/install-git-hooks.mjs'], {
		cwd: repo,
		env: { ...env, ...extraEnv },
		encoding: 'utf8',
	});
}

/** Commits a new file with `message`; returns whether the commit landed. */
function commit(message: string, ...flags: string[]): boolean {
	writeFileSync(join(repo, `${Math.random()}.txt`), message);
	git('add', '-A');
	return spawnSync('git', ['commit', '-q', '-m', message, ...flags], { cwd: repo, env }).status === 0;
}

describe('the installer', () => {
	it('points git at .githooks', () => {
		setup();
		expect(install()).toMatch(/enabled/);
		expect(git('config', '--get', 'core.hooksPath')).toBe('.githooks');
	});

	it('is quiet when the hooks are already enabled', () => {
		setup();
		install();
		expect(install()).toBe('');
	});

	it('leaves a hooks path someone else chose alone', () => {
		setup();
		git('config', 'core.hooksPath', '.husky');
		expect(install()).toMatch(/already "\.husky"/);
		expect(git('config', '--get', 'core.hooksPath')).toBe('.husky');
	});

	it('does nothing in CI', () => {
		setup();
		install({ CI: 'true' });
		expect(spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: repo, env }).status).toBe(1);
	});
});

describe('commit-msg', () => {
	it('accepts a Conventional Commits subject, and rejects anything else', () => {
		setup();
		install();
		expect(commit('feat: open bibliography files')).toBe(true);
		expect(commit('fix(deps)!: drop an old option')).toBe(true);
		expect(commit('Render only the pages on screen')).toBe(false);
		expect(commit('Feat: capitalised type')).toBe(false);
	});

	it('reads the subject, not the body or git comments', () => {
		setup();
		install();
		expect(commit('docs: explain the fold\n\nNot a conventional line, and that is fine.')).toBe(true);
	});

	it('lets autosquash and merge subjects through while work is in progress', () => {
		setup();
		install();
		expect(commit('fixup! feat: open bibliography files')).toBe(true);
		expect(commit("Merge branch 'main' into feat/x")).toBe(true);
	});

	it('can be bypassed on purpose', () => {
		setup();
		install();
		expect(commit('WIP', '--no-verify')).toBe(true);
	});
});

describe('pre-push', () => {
	/** Runs the hook as `git push` would, for a push of HEAD to `remoteRef`. */
	function prePush(remoteRef: string, remoteSha: string): boolean {
		const head = git('rev-parse', 'HEAD');
		return (
			spawnSync('sh', ['.githooks/pre-push', 'origin', 'url'], {
				cwd: repo,
				env,
				input: `refs/heads/main ${head} ${remoteRef} ${remoteSha}\n`,
			}).status === 0
		);
	}

	it('stops a subject slipped past commit-msg from reaching main', () => {
		setup();
		install();
		commit('feat: first');
		const base = git('rev-parse', 'HEAD');
		commit('fix: second');
		expect(prePush('refs/heads/main', base)).toBe(true);
		commit('not conventional', '--no-verify');
		expect(prePush('refs/heads/main', base)).toBe(false);
	});

	it('does not check other branches, whose subjects are squashed away', () => {
		setup();
		install();
		commit('feat: first');
		const base = git('rev-parse', 'HEAD');
		commit('wip', '--no-verify');
		expect(prePush('refs/heads/feat/x', base)).toBe(true);
	});
});
