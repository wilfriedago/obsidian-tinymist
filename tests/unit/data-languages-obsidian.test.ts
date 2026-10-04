import { describe, expect, it, vi } from 'vitest'

/*
 * Obsidian's `@codemirror/language` exports `lineHighlighter`, which is what
 * draws a stream language's tokens there. Stock CodeMirror does not, so it is
 * added here the way Obsidian provides it.
 */
const lineHighlighter = vi.hoisted(() => ({ obsidian: 'lineHighlighter' }))

vi.mock('@codemirror/language', async (importOriginal) => ({
	...(await importOriginal<typeof import('@codemirror/language')>()),
	lineHighlighter
}))

const { dataLanguageFor } = await import('../../src/editor/data-languages')

describe("Obsidian's stream highlighting", () => {
	it('is added for every data file, when Obsidian provides it', () => {
		for (const extension of ['bib', 'yml', 'yaml', 'toml']) {
			expect(dataLanguageFor(extension).flat(), extension).toContain(lineHighlighter)
		}
	})

	it('is not added for a file with no language', () => {
		expect(dataLanguageFor('txt')).toEqual([])
	})
})
