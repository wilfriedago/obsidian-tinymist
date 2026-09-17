import { describe, expect, it } from 'vitest';

import {
	ancestorsInclusive,
	describeProject,
	resolveProject,
	type ProjectFileSystem,
} from '../../src/typst/project/project';

/** A vault whose contents are just a set of paths. */
function vault(...paths: string[]): ProjectFileSystem {
	const set = new Set(paths);
	return { exists: (path) => set.has(path) };
}

describe('ancestorsInclusive', () => {
	it('walks from the directory up to the vault root', () => {
		expect(ancestorsInclusive('papers/thesis/chapters')).toEqual([
			'papers/thesis/chapters',
			'papers/thesis',
			'papers',
			'',
		]);
	});

	it('returns just the root for the root', () => {
		expect(ancestorsInclusive('')).toEqual(['']);
	});
});

describe('resolveProject, automatic strategy', () => {
	const auto = { strategy: 'auto' as const, customRoot: '' };

	it('uses the nearest ancestor holding a typst.toml', () => {
		const fs = vault('papers/thesis/typst.toml');
		expect(resolveProject(fs, 'papers/thesis/chapters/intro.typ', auto)).toEqual({
			root: 'papers/thesis',
			origin: 'manifest',
			manifestPath: 'papers/thesis/typst.toml',
		});
	});

	it('prefers the nearest manifest when several are nested', () => {
		const fs = vault('typst.toml', 'papers/typst.toml', 'papers/thesis/typst.toml');
		expect(resolveProject(fs, 'papers/thesis/main.typ', auto).root).toBe('papers/thesis');
	});

	it("falls back to the document's own folder when there is no manifest", () => {
		// This is the case the vault-root assumption gets wrong: two papers in
		// two folders must not share one project.
		expect(resolveProject(vault(), 'papers/one/main.typ', auto)).toEqual({
			root: 'papers/one',
			origin: 'parent-directory',
			manifestPath: null,
		});
	});

	it('keeps sibling projects apart', () => {
		const fs = vault('papers/a/typst.toml', 'papers/b/typst.toml');
		expect(resolveProject(fs, 'papers/a/main.typ', auto).root).toBe('papers/a');
		expect(resolveProject(fs, 'papers/b/main.typ', auto).root).toBe('papers/b');
	});

	it('finds a manifest sitting at the vault root', () => {
		expect(resolveProject(vault('typst.toml'), 'notes/main.typ', auto)).toMatchObject({
			root: '',
			origin: 'manifest',
		});
	});

	it('handles a document at the vault root', () => {
		expect(resolveProject(vault(), 'main.typ', auto)).toMatchObject({
			root: '',
			origin: 'parent-directory',
		});
	});
});

describe('resolveProject, other strategies', () => {
	it('always answers the vault root under the vault strategy', () => {
		expect(
			resolveProject(vault('papers/a/typst.toml'), 'papers/a/main.typ', {
				strategy: 'vault',
				customRoot: '',
			}),
		).toEqual({ root: '', origin: 'vault', manifestPath: null });
	});

	it('uses the configured folder under the custom strategy, ignoring manifests', () => {
		expect(
			resolveProject(vault('papers/a/typst.toml'), 'papers/a/main.typ', {
				strategy: 'custom',
				customRoot: '/shared/root/',
			}),
		).toEqual({ root: 'shared/root', origin: 'configured', manifestPath: null });
	});
});

describe('describeProject', () => {
	it('names the vault root readably', () => {
		expect(describeProject({ root: '', origin: 'vault', manifestPath: null })).toBe(
			'vault root (whole vault)',
		);
	});

	it('says which rule decided the root', () => {
		expect(
			describeProject({
				root: 'papers/a',
				origin: 'manifest',
				manifestPath: 'papers/a/typst.toml',
			}),
		).toBe('papers/a (typst.toml)');
		expect(
			describeProject({ root: 'papers/a', origin: 'parent-directory', manifestPath: null }),
		).toBe("papers/a (file's folder)");
	});
});
