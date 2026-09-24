#!/usr/bin/env node
/**
 * Checks commit subjects, or a pull request title, which becomes the squash
 * subject, against Conventional Commits.
 *
 * release-please derives the next version and the fallback changelog entries
 * from these subjects and silently skips anything it cannot parse, so a
 * malformed subject is a change that never reaches a release.
 *
 * Usage: check-commit-subject.mjs "<subject>" ...   or one subject per line on stdin.
 */
import { readFileSync } from 'node:fs';

const TYPES = ['feat', 'fix', 'perf', 'revert', 'docs', 'test', 'refactor', 'style', 'build', 'ci', 'chore'];
const conventional = new RegExp(`^(${TYPES.join('|')})(\\([a-z0-9][a-z0-9-]*\\))?!?: \\S`);
// GitHub's own revert titles, which release-please also understands.
const githubRevert = /^Revert ".+"$/;

const args = process.argv.slice(2);
const subjects = (args.length > 0 ? args : readFileSync(0, 'utf8').split('\n'))
	.map((line) => line.trim())
	.filter(Boolean);

const bad = subjects.filter((subject) => !conventional.test(subject) && !githubRevert.test(subject));
if (bad.length > 0) {
	console.error('Not Conventional Commits, so release-please will ignore these:');
	for (const subject of bad) console.error(`  - ${subject}`);
	console.error(`Expected "<type>[(scope)][!]: <summary>", with type one of: ${TYPES.join(', ')}.`);
	process.exit(1);
}
console.log(`ok: ${subjects.length} subject(s)`);
