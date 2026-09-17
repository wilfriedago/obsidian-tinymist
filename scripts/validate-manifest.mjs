#!/usr/bin/env node
/**
 * Checks `manifest.json` and `versions.json` against the rules the Obsidian
 * community directory enforces, so a release never fails review on something a
 * script could have caught.
 *
 * The authoritative list lives in the directory's own validation workflow:
 * https://github.com/obsidianmd/obsidian-releases/blob/master/.github/workflows/validate-plugin-entry.yml
 */
import { readFileSync } from 'node:fs';

const problems = [];
const check = (condition, message) => {
	if (!condition) {
		problems.push(message);
	}
};

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

// Required fields.
for (const field of [
	'id',
	'name',
	'version',
	'minAppVersion',
	'description',
	'author',
	'isDesktopOnly',
]) {
	check(manifest[field] !== undefined, `manifest.json is missing "${field}"`);
}

// id: lowercase letters, numbers and hyphens; no "obsidian"; not ending "plugin".
check(/^[a-z0-9-]+$/.test(manifest.id), `id "${manifest.id}" may use only lowercase letters, numbers and hyphens`);
check(!manifest.id.includes('obsidian'), `id "${manifest.id}" must not contain "obsidian"`);
check(!manifest.id.endsWith('plugin'), `id "${manifest.id}" must not end with "plugin"`);

// name: no "Obsidian", no "Plugin".
check(!/obsidian/i.test(manifest.name), `name "${manifest.name}" must not contain "Obsidian"`);
check(!/\bplugin\b/i.test(manifest.name), `name "${manifest.name}" must not contain "Plugin"`);

// description: <= 250 chars, ends with a period, no emoji.
check(
	manifest.description.length <= 250,
	`description is ${manifest.description.length} characters; the limit is 250`,
);
check(manifest.description.endsWith('.'), 'description must end with a period');
check(
	!/\p{Extended_Pictographic}/u.test(manifest.description),
	'description must not contain emoji',
);
check(
	!/^this is a plugin/i.test(manifest.description),
	'description should not start with "This is a plugin"',
);

// Versions must be strict x.y.z semver.
const semver = /^\d+\.\d+\.\d+$/;
check(semver.test(manifest.version), `version "${manifest.version}" must be x.y.z`);
check(
	semver.test(manifest.minAppVersion),
	`minAppVersion "${manifest.minAppVersion}" must be x.y.z`,
);

// versions.json has to map this release to a minimum app version.
check(
	versions[manifest.version] !== undefined,
	`versions.json has no entry for ${manifest.version}`,
);
check(
	versions[manifest.version] === manifest.minAppVersion,
	`versions.json maps ${manifest.version} to ${versions[manifest.version]}, but the manifest says ${manifest.minAppVersion}`,
);
for (const [pluginVersion, appVersion] of Object.entries(versions)) {
	check(semver.test(pluginVersion), `versions.json key "${pluginVersion}" must be x.y.z`);
	check(semver.test(appVersion), `versions.json value "${appVersion}" must be x.y.z`);
}

// package.json and the manifest must agree, since `npm version` drives both.
check(
	pkg.version === manifest.version,
	`package.json is ${pkg.version} but manifest.json is ${manifest.version}`,
);

// fundingUrl is only for genuine funding links.
check(
	manifest.fundingUrl === undefined || typeof manifest.fundingUrl !== 'string' || /^https?:\/\//.test(manifest.fundingUrl),
	'fundingUrl must be a URL',
);

// This plugin launches a native executable, so it cannot claim mobile support.
check(manifest.isDesktopOnly === true, 'isDesktopOnly must be true while the plugin spawns Tinymist');

if (problems.length > 0) {
	console.error('manifest validation failed:');
	for (const problem of problems) {
		console.error(`  - ${problem}`);
	}
	process.exit(1);
}

console.log(`manifest ok: ${manifest.id} ${manifest.version} (minAppVersion ${manifest.minAppVersion})`);
