#!/usr/bin/env node
/**
 * Installs pjeby's Hot Reload into `test-vault/`, which is what turns a watch
 * build into a live reload.
 *
 * It is a development tool for this repository, not a dependency of the
 * plugin: nothing here runs for a user, nothing is bundled, and it only ever
 * writes inside `test-vault/`. Hot Reload is not in the community directory,
 * so there is no in-app way to install it — hence a script, kept separate from
 * `pnpm dev` so that the one command that reaches the network is one you type
 * on purpose.
 *
 * https://github.com/pjeby/hot-reload
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RELEASE = 'https://github.com/pjeby/hot-reload/releases/latest/download';
const FILES = ['main.js', 'manifest.json'];

const root = resolve(import.meta.dirname, '..');
const target = resolve(root, 'test-vault/.obsidian/plugins/hot-reload');

mkdirSync(target, { recursive: true });

for (const file of FILES) {
	const url = `${RELEASE}/${file}`;
	process.stdout.write(`${url} … `);

	const response = await fetch(url);
	if (!response.ok) {
		console.log('failed');
		console.error(`\n${url} returned ${response.status} ${response.statusText}.`);
		console.error('Download main.js and manifest.json by hand into:');
		console.error(`  ${target}`);
		process.exit(1);
	}

	writeFileSync(resolve(target, file), Buffer.from(await response.arrayBuffer()));
	console.log('ok');
}

console.log('');
console.log('Installed into test-vault/.obsidian/plugins/hot-reload.');
console.log('Enable "Hot Reload" under Settings → Community plugins, then restart Obsidian once.');
