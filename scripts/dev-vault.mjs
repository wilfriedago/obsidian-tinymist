#!/usr/bin/env node
/**
 * Prepares `test-vault/` so a watch build lands in a running Obsidian.
 *
 * Three things have to be true before live reloading works, and getting one of
 * them wrong fails quietly — the plugin simply never changes. This script makes
 * all three true, and is safe to run again at any time:
 *
 * 1. `test-vault/.obsidian/plugins/tinymist` is a symlink to `dist/`, which is
 *    the complete plugin folder the build produces.
 * 2. `dist/.hotreload` exists, which is the marker the Hot Reload plugin looks
 *    for to decide a plugin is under development.
 * 3. The Hot Reload plugin itself is installed in the vault. That one needs a
 *    download, so it is reported rather than done.
 *
 * Nothing here touches a vault other than `test-vault/`, and nothing that is
 * not recognizably this script's own work is ever deleted.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Not `import.meta.dirname`, which needs Node 20.11 while the project asks for
// Node 20. This form works on every version that has ES modules at all.
const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '..');
const dist = resolve(root, 'dist');
const pluginsDir = resolve(root, 'test-vault/.obsidian/plugins');
const link = resolve(pluginsDir, 'tinymist');
const hotReloadDir = resolve(pluginsDir, 'hot-reload');

const notes = [];
const say = (message) => console.log(message);

/* -------------------------------------------------------------------------- */
/* 1. A plugin folder for the build to land in                                */
/* -------------------------------------------------------------------------- */

// Created up front so the symlink is never dangling: Obsidian skips a plugin
// folder it cannot read, and would need a restart rather than a reload once the
// first build finally appeared.
mkdirSync(dist, { recursive: true });
mkdirSync(pluginsDir, { recursive: true });

if (existsSync(link) || isBrokenLink(link)) {
	const stats = lstatSync(link);

	if (stats.isSymbolicLink()) {
		const current = resolve(pluginsDir, readlinkSync(link));
		if (current === dist) {
			say(`✓ ${short(link)} → dist/`);
		} else {
			rmSync(link);
			linkDist();
			say(`✓ ${short(link)} → dist/ (was pointing at ${current})`);
		}
	} else if (stats.isDirectory() && readdirSync(link).length === 0) {
		// An empty directory here is the usual state of a fresh clone, and it is
		// also what makes the obvious `ln -sfn dist …` command silently do the
		// wrong thing: with a real directory as the target, `ln` puts the link
		// *inside* it.
		rmSync(link, { recursive: true });
		linkDist();
		say(`✓ ${short(link)} → dist/ (replaced an empty directory)`);
	} else {
		// A real directory with files in it is either a copied build or somebody's
		// settings. Deleting it is not this script's call to make.
		fail(
			`${short(link)} is a directory with files in it, so it was left alone.`,
			'Move or delete it, then run this again:',
			`  rm -rf ${short(link)}`,
		);
	}
} else {
	linkDist();
	say(`✓ ${short(link)} → dist/`);
}

/* -------------------------------------------------------------------------- */
/* 2. The marker that makes Hot Reload watch this plugin                      */
/* -------------------------------------------------------------------------- */

const marker = resolve(dist, '.hotreload');
if (existsSync(marker)) {
	say('✓ dist/.hotreload');
} else {
	writeFileSync(marker, '');
	say('✓ dist/.hotreload (created)');
}

/* -------------------------------------------------------------------------- */
/* 3. Debug logging, so the console is worth opening                          */
/* -------------------------------------------------------------------------- */

// Obsidian writes plugin settings into the plugin folder, which is `dist/` here.
// Seeded only when absent, so a setting changed in the app is never overwritten.
const data = resolve(dist, 'data.json');
if (!existsSync(data)) {
	writeFileSync(data, `${JSON.stringify({ logLevel: 'debug' }, null, '\t')}\n`);
	say('✓ dist/data.json (logging set to debug)');
}

/* -------------------------------------------------------------------------- */
/* 4. Hot Reload itself, which needs a download                               */
/* -------------------------------------------------------------------------- */

if (existsSync(resolve(hotReloadDir, 'main.js'))) {
	say('✓ hot-reload plugin installed');
} else {
	notes.push(
		'Hot Reload is not installed, so rebuilds will need Ctrl/Cmd+R in Obsidian.',
		'It is a third-party plugin and is not in the community directory, so install it by hand:',
		'',
		'  pnpm dev:hot-reload',
		'',
		'Then enable "Hot Reload" under Settings → Community plugins.',
	);
}

say('');
if (notes.length > 0) {
	for (const note of notes) {
		say(note);
	}
	say('');
}
say('Open test-vault/ as a vault and enable Tinymist under Community plugins.');

/* -------------------------------------------------------------------------- */

function linkDist() {
	try {
		// Relative, so the vault keeps working if the checkout is moved.
		symlinkSync(relative(pluginsDir, dist), link, 'dir');
	} catch (error) {
		if (error.code === 'EPERM') {
			fail(
				'Creating a symlink was not permitted.',
				'On Windows this needs Developer Mode, or an elevated shell.',
				'Otherwise copy dist/ into the plugin folder after each build instead.',
			);
		}
		throw error;
	}
}

/** `existsSync` follows symlinks, so a broken one reads as absent. */
function isBrokenLink(path) {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function short(path) {
	return relative(root, path) || path;
}

function fail(...lines) {
	for (const line of lines) {
		console.error(line);
	}
	process.exit(1);
}
