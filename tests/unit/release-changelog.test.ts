import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The release workflow's changelog step, run the way the workflow runs it.
 *
 * The generated section below is what release-please 17 actually writes, taken
 * from its own changelog-notes and updater code, including where it puts the
 * section: above `## [Unreleased]`, not in place of it.
 */

const SCRIPT = resolve(__dirname, '../../scripts/release-changelog.mjs');

const PREAMBLE = `# Changelog

All notable changes to this project are documented here.
`;

const GENERATED = `## [0.5.0](https://github.com/wilfriedago/obsidian-tinymist/compare/0.4.0...0.5.0) (2026-09-30)


### Added

* open and create BibLaTeX bibliography files ([#12](https://github.com/wilfriedago/obsidian-tinymist/issues/12)) ([a7eb5bc](https://github.com/wilfriedago/obsidian-tinymist/commit/a7eb5bcd))


### Fixed

* bump codemirror-lang-typst ([#20](https://github.com/wilfriedago/obsidian-tinymist/issues/20)) ([0badf00](https://github.com/wilfriedago/obsidian-tinymist/commit/0badf00d))
`;

const UNRELEASED = `## [Unreleased]

### Added

- **BibLaTeX bibliographies open in Obsidian.** Written by hand, in prose.
`;

const HISTORY = `## [0.4.0] - 2026-09-22

### Added

- **The preview renders only the pages on screen.**
`;

let directory = '';

afterEach(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
	directory = '';
});

function run(changelog: string, ...args: string[]): { changelog: string; stdout: string } {
	directory = directory || mkdtempSync(join(tmpdir(), 'release-changelog-'));
	writeFileSync(join(directory, 'CHANGELOG.md'), changelog);
	writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: '0.5.0' }));
	const stdout = execFileSync('node', [SCRIPT, ...args], { cwd: directory, encoding: 'utf8' });
	return { changelog: readFileSync(join(directory, 'CHANGELOG.md'), 'utf8'), stdout };
}

describe('fold', () => {
	it('uses the hand-written Unreleased prose in place of the generated entries', () => {
		const { changelog } = run(`${PREAMBLE}\n${GENERATED}\n${UNRELEASED}\n${HISTORY}`, 'fold');
		expect(changelog).toBe(
			`${PREAMBLE}\n## [0.5.0] - 2026-09-30\n\n### Added\n\n- **BibLaTeX bibliographies open in Obsidian.** Written by hand, in prose.\n\n${HISTORY}`,
		);
	});

	it('keeps the generated entries, restyled, when nothing was written by hand', () => {
		const { changelog } = run(`${PREAMBLE}\n${GENERATED}\n${HISTORY}`, 'fold');
		expect(changelog).toContain('## [0.5.0] - 2026-09-30\n\n### Added\n\n- open and create');
		// The pull-request link stays; the commit-hash link does not.
		expect(changelog).toContain('files ([#12](https://github.com/wilfriedago/obsidian-tinymist/issues/12))\n');
		expect(changelog).not.toContain('/commit/');
		expect(changelog).not.toMatch(/\n{3,}/);
		expect(changelog.endsWith(HISTORY)).toBe(true);
	});

	it('leaves an already folded changelog exactly as it is', () => {
		const once = run(`${PREAMBLE}\n${GENERATED}\n${UNRELEASED}\n${HISTORY}`, 'fold').changelog;
		const { changelog, stdout } = run(once, 'fold');
		expect(changelog).toBe(once);
		expect(stdout).toMatch(/already folded/);
	});

	it('fails when the release has no section at all', () => {
		expect(() => run(`${PREAMBLE}\n${UNRELEASED}\n${HISTORY}`, 'fold')).toThrow();
	});
});

describe('notes', () => {
	it('prints the section that becomes the GitHub release body', () => {
		const folded = run(`${PREAMBLE}\n${GENERATED}\n${UNRELEASED}\n${HISTORY}`, 'fold').changelog;
		const { stdout } = run(folded, 'notes', '0.5.0');
		expect(stdout).toBe('### Added\n\n- **BibLaTeX bibliographies open in Obsidian.** Written by hand, in prose.\n');
	});

	it('reads an older, hand-made section too', () => {
		expect(run(`${PREAMBLE}\n${HISTORY}`, 'notes', '0.4.0').stdout).toBe(
			'### Added\n\n- **The preview renders only the pages on screen.**\n',
		);
	});
});
