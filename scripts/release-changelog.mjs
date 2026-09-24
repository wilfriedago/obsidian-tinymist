#!/usr/bin/env node
/**
 * Keeps CHANGELOG.md in this project's own style once release-please is
 * involved.
 *
 * release-please writes a section of one-line entries generated from commit
 * subjects, under a heading of its own format, and inserts it *above* any
 * `## [Unreleased]` section rather than using it. This project's changelog is
 * prose written by hand under Unreleased, so on the release branch:
 *
 *   fold [version]   Replaces the generated section's body with the
 *                    Unreleased prose, when there is any, and removes the
 *                    Unreleased heading. Without prose, the generated entries
 *                    are kept, restyled. Either way the heading becomes
 *                    `## [x.y.z] - yyyy-mm-dd`, like every earlier one.
 *                    Idempotent: a folded changelog is left as it is.
 *
 *   notes <version>  Prints that version's section, which becomes the GitHub
 *                    release body, so the release reads like the changelog.
 *
 * `version` defaults to the one in package.json. Both work on CHANGELOG.md in
 * the current directory.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The span of the `## …` section starting at `start`, up to the next `## `. */
function sectionEnd(content, start) {
	const next = content.slice(start + 1).search(/^## /m);
	return next === -1 ? content.length : start + 1 + next;
}

/** Drops commit-hash links; the pull-request link is the one worth keeping. */
function restyleGenerated(body) {
	return body
		.replace(/^\* /gm, '- ')
		.replace(/ \(\[[0-9a-f]{7,40}\]\([^)]*\/commit\/[0-9a-f]{7,40}\)\)/g, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function foldRelease(content, version) {
	const v = escape(version);
	const generated = new RegExp(`^## \\[${v}\\](?:\\([^)]*\\))? \\((\\d{4}-\\d{2}-\\d{2})\\)[ \\t]*$`, 'm');
	const folded = new RegExp(`^## \\[${v}\\] - \\d{4}-\\d{2}-\\d{2}[ \\t]*$`, 'm');

	const match = generated.exec(content);
	if (!match) {
		if (folded.test(content)) {
			return content;
		}
		throw new Error(`CHANGELOG.md has no section for ${version}.`);
	}
	const date = match[1];

	let unreleasedBody = '';
	const unreleased = /^## \[?Unreleased\]?[ \t]*$/im.exec(content);
	if (unreleased) {
		const end = sectionEnd(content, unreleased.index);
		unreleasedBody = content.slice(unreleased.index + unreleased[0].length, end).trim();
		content = content.slice(0, unreleased.index) + content.slice(end);
	}

	// Located again: removing Unreleased may have moved it.
	const start = generated.exec(content).index;
	const end = sectionEnd(content, start);
	const generatedBody = content.slice(start, end).replace(generated, '');
	const body = unreleasedBody || restyleGenerated(generatedBody);

	return `${content.slice(0, start)}## [${version}] - ${date}\n\n${body}\n\n${content.slice(end)}`
		.replace(/\n{3,}(?=## )/g, '\n\n')
		.trimEnd() + '\n';
}

function releaseNotes(content, version) {
	const heading = new RegExp(`^## \\[${escape(version)}\\].*$`, 'm');
	const match = heading.exec(content);
	if (!match) {
		throw new Error(`CHANGELOG.md has no section for ${version}.`);
	}
	return content.slice(match.index + match[0].length, sectionEnd(content, match.index)).trim() + '\n';
}

const [command, argument] = process.argv.slice(2);
const version = argument ?? JSON.parse(readFileSync('package.json', 'utf8')).version;
const changelog = readFileSync('CHANGELOG.md', 'utf8');

if (command === 'fold') {
	const next = foldRelease(changelog, version);
	if (next !== changelog) {
		writeFileSync('CHANGELOG.md', next);
		console.log(`Folded the ${version} section into the project's changelog style.`);
	} else {
		console.log(`The ${version} section is already folded.`);
	}
} else if (command === 'notes') {
	process.stdout.write(releaseNotes(changelog, version));
} else {
	console.error('Usage: release-changelog.mjs fold [version] | notes <version>');
	process.exit(2);
}
