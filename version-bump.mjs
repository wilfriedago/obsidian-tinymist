import { readFileSync, writeFileSync } from 'fs';

// Set by `npm version`; read from package.json when the release workflow calls
// this directly, after release-please has bumped it.
const targetVersion =
	process.env.npm_package_version ?? JSON.parse(readFileSync('package.json', 'utf8')).version;

// read minAppVersion from manifest.json and bump version to target version
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync('manifest.json', JSON.stringify(manifest, null, '\t') + '\n');

// update versions.json with target version and minAppVersion from manifest.json
// but only if the target version is not already in versions.json
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
if (!(targetVersion in versions)) {
	versions[targetVersion] = minAppVersion;
	writeFileSync('versions.json', JSON.stringify(versions, null, '\t') + '\n');
}
