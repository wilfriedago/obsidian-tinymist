import { describe, expect, it } from 'vitest';

import { availableFilePath } from '../../src/plugin/new-file';

/**
 * Naming follows Obsidian's own convention for new notes — `Untitled`, then
 * `Untitled 1` — so a Typst file created here looks like it belongs beside the
 * Markdown ones rather than following some scheme of this plugin's invention.
 */
describe('availableFilePath', () => {
	const vault = (...paths: string[]) => {
		const set = new Set(paths);
		return (path: string) => set.has(path);
	};

	it('uses the plain name when nothing is taken', () => {
		expect(availableFilePath('papers', vault())).toBe('papers/Untitled.typ');
	});

	it('numbers with a space, as Obsidian does', () => {
		expect(availableFilePath('papers', vault('papers/Untitled.typ'))).toBe(
			'papers/Untitled 1.typ',
		);
	});

	it('keeps counting past a run of taken names', () => {
		const taken = vault(
			'papers/Untitled.typ',
			'papers/Untitled 1.typ',
			'papers/Untitled 2.typ',
		);
		expect(availableFilePath('papers', taken)).toBe('papers/Untitled 3.typ');
	});

	it('creates at the vault root when the folder is empty', () => {
		expect(availableFilePath('', vault())).toBe('Untitled.typ');
		expect(availableFilePath('', vault('Untitled.typ'))).toBe('Untitled 1.typ');
	});

	it('does not collide with a Markdown note of the same name', () => {
		// Only the `.typ` name matters; an existing Untitled.md is unrelated.
		expect(availableFilePath('notes', vault('notes/Untitled.md'))).toBe(
			'notes/Untitled.typ',
		);
	});

	it('normalizes a folder path with a trailing slash', () => {
		expect(availableFilePath('papers/', vault())).toBe('papers/Untitled.typ');
	});

	it('handles a nested folder', () => {
		expect(availableFilePath('papers/thesis/chapters', vault())).toBe(
			'papers/thesis/chapters/Untitled.typ',
		);
	});

	it('gives up rather than looping forever', () => {
		// Pathological, but an infinite loop inside a context-menu click would
		// hang the app rather than report anything.
		expect(() => availableFilePath('x', () => true)).toThrowError(
			expect.objectContaining({ code: 'document-sync-failed' }),
		);
	});
});

describe('availableFilePath for bibliographies', () => {
	const vault = (...paths: string[]) => {
		const set = new Set(paths);
		return (path: string) => set.has(path);
	};

	it('names a bibliography the same way', () => {
		expect(availableFilePath('papers', vault(), undefined, 'bib')).toBe('papers/Untitled.bib');
	});

	it('does not collide with a Typst file of the same name', () => {
		// `Untitled.typ` and `Untitled.bib` side by side is the normal project shape.
		expect(availableFilePath('papers', vault('papers/Untitled.typ'), undefined, 'bib')).toBe(
			'papers/Untitled.bib',
		);
	});

	it('numbers past an existing bibliography', () => {
		expect(availableFilePath('papers', vault('papers/Untitled.bib'), undefined, 'bib')).toBe(
			'papers/Untitled 1.bib',
		);
	});
});
