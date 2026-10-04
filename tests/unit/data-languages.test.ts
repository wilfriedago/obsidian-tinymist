import { readFileSync } from 'node:fs'

import { type StreamParser, StringStream } from '@codemirror/language'

import { describe, expect, it } from 'vitest'

import { bibtex, dataLanguageFor, tomlParser, yamlParser } from '../../src/editor/data-languages'

/** Runs a stream parser the way CodeMirror does, one line at a time. */
function tokens<State>(parser: StreamParser<State>, text: string): [string, string | null][] {
	const state = parser.startState!(2)
	const out: [string, string | null][] = []
	for (const line of text.split('\n')) {
		const stream = new StringStream(line, 4, 2)
		while (!stream.eol()) {
			const style = parser.token(stream, state)
			// CodeMirror throws on a token that consumes nothing; so does this,
			// rather than looping forever.
			if (stream.pos === stream.start) {
				throw new Error(`No progress at column ${stream.pos} of ${JSON.stringify(line)}`)
			}
			const current = stream.current()
			if (current.trim() !== '') {
				out.push([current, style])
			}
			stream.start = stream.pos
		}
	}
	return out
}

/** The style of every token whose text is exactly `text`. */
function styleOf(parsed: [string, string | null][], text: string): (string | null)[] {
	return parsed.filter(([t]) => t === text).map(([, style]) => style)
}

describe('BibTeX highlighting', () => {
	const entry = [
		'@article{knuth1984,',
		'  title = {Literate {P}rogramming},',
		'  year = 1984,',
		'  author = "Donald " # knuth,',
		'}'
	].join('\n')

	it('marks the entry type, citation key, and field names', () => {
		const parsed = tokens(bibtex, entry)
		expect(styleOf(parsed, '@article')).toEqual(['keyword'])
		expect(styleOf(parsed, 'knuth1984')).toEqual(['labelName'])
		expect(styleOf(parsed, 'title')).toEqual(['propertyName'])
		expect(styleOf(parsed, 'year')).toEqual(['propertyName'])
	})

	it('reads nested braces as one value', () => {
		expect(styleOf(tokens(bibtex, entry), '{Literate {P}rogramming}')).toEqual(['string'])
	})

	it('tells numbers, quoted strings, and macros apart', () => {
		const parsed = tokens(bibtex, entry)
		expect(styleOf(parsed, '1984')).toEqual(['number'])
		expect(styleOf(parsed, '"Donald "')).toEqual(['string'])
		expect(styleOf(parsed, '#')).toEqual(['operator'])
		expect(styleOf(parsed, 'knuth')).toEqual(['variableName'])
	})

	it('carries a braced value across lines', () => {
		const parsed = tokens(bibtex, '@book{k,\n  note = {first line\n  second line},\n  year = 2000\n}')
		expect(styleOf(parsed, '{first line')).toEqual(['string'])
		expect(styleOf(parsed, '  second line}')).toEqual(['string'])
		expect(styleOf(parsed, 'year')).toEqual(['propertyName'])
	})

	it('keeps a quote inside braces from ending a quoted value', () => {
		const parsed = tokens(bibtex, '@misc{k, title = "a {"} b", year = 1}')
		expect(styleOf(parsed, '"a {"} b"')).toEqual(['string'])
		expect(styleOf(parsed, 'year')).toEqual(['propertyName'])
	})

	it('treats text between entries, and @comment, as comments', () => {
		const parsed = tokens(bibtex, '% mail me@example.org\nloose text\n@comment{ignored {nested} }\n@book{k, year = 1}')
		expect(styleOf(parsed, '% mail me@example.org')).toEqual(['comment'])
		expect(styleOf(parsed, 'loose text')).toEqual(['comment'])
		expect(styleOf(parsed, 'ignored {nested} }')).toEqual(['comment'])
		expect(styleOf(parsed, 'k')).toEqual(['labelName'])
	})

	it('reads % inside an entry as a comment, outside values only', () => {
		const parsed = tokens(
			bibtex,
			'@book{ % before the key\n  k,\n  title = {50% off}, % trailing = note\n  % whole line\n  year = 1\n}'
		)
		expect(styleOf(parsed, '% before the key')).toEqual(['comment'])
		expect(styleOf(parsed, 'k')).toEqual(['labelName'])
		expect(styleOf(parsed, '{50% off}')).toEqual(['string'])
		expect(styleOf(parsed, '% trailing = note')).toEqual(['comment'])
		expect(styleOf(parsed, '% whole line')).toEqual(['comment'])
		expect(styleOf(parsed, 'year')).toEqual(['propertyName'])
	})

	it('reads an @ that starts no entry as text, and moves past it', () => {
		const parsed = tokens(bibtex, '@ not an entry\ncontact@ 2024\n@1 @@\n@book{k, year = 1}')
		expect(styleOf(parsed, 'contact')).toEqual(['comment'])
		expect(styleOf(parsed, '@book')).toEqual(['keyword'])
		expect(styleOf(parsed, 'k')).toEqual(['labelName'])
	})

	it('gives @string a field, not a citation key', () => {
		const parsed = tokens(bibtex, '@string{jan = "January"}')
		expect(styleOf(parsed, 'jan')).toEqual(['propertyName'])
	})

	it('accepts parentheses around an entry', () => {
		const parsed = tokens(bibtex, '@book(k, year = 1)\n@misc{m}')
		expect(styleOf(parsed, 'k')).toEqual(['labelName'])
		expect(styleOf(parsed, 'm')).toEqual(['labelName'])
	})
})

describe('YAML and TOML highlighting', () => {
	it('shows YAML mapping keys as properties', () => {
		const parsed = tokens(yamlParser, 'knuth1984:\n  type: book\n  date: 1984')
		expect(styleOf(parsed, 'knuth1984')).toEqual(['propertyName'])
		expect(styleOf(parsed, '  type')).toEqual(['propertyName'])
	})

	it('gives TOML tables their own style, apart from keys and booleans', () => {
		const parsed = tokens(tomlParser, '[package]\nname = "fixture"\nexact = true')
		expect(styleOf(parsed, '[package]')).toEqual(['heading'])
		expect(styleOf(parsed, 'name')).toEqual(['propertyName'])
		expect(styleOf(parsed, 'true')).toEqual(['atom'])
	})
})

/*
 * In Obsidian, a token is colored only by a `cm-<name>` rule in `styles.css`,
 * never by `dataHighlightStyle` (see `obsidianLineHighlighter`). These samples
 * reach every branch of each parser, so a name without a rule is caught here
 * rather than as plain text in a vault.
 */
describe('colors in Obsidian', () => {
	const samples: [string, StreamParser<unknown>, string][] = [
		[
			'bib',
			bibtex as StreamParser<unknown>,
			'% note\n@string{jan = "January"}\n@article(k,\n  title = {A {B}},\n  year = 1984,\n  month = jan # "1",\n)\n@comment{x}'
		],
		[
			'yaml',
			yamlParser,
			'%YAML 1.2\n---\n# c\nkey: "v"\nlist:\n  - &a 1\n  - *a\nflag: true\nmap: {a: 1, b: [x]}\ntext: |\n  block\n...'
		],
		['toml', tomlParser, '# c\n[table]\n[[array]]\nkey = "v"\nn = 1.5\nflag = false\nlist = [1, 2]\ndate = 1979-05-27']
	]
	const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8')
	const styled = new Set([...css.matchAll(/\.cm-([\w-]+)/g)].map((match) => match[1]))

	for (const [name, parser, text] of samples) {
		it(`has a rule for every ${name} token`, () => {
			const emitted = new Set(tokens(parser, text).flatMap(([, style]) => style?.split(' ') ?? []))
			expect([...emitted].filter((style) => !styled.has(style))).toEqual([])
		})
	}
})

describe('choosing a language', () => {
	it('highlights every extension the data editor opens', () => {
		for (const extension of ['bib', 'yml', 'yaml', 'toml', 'BIB']) {
			expect(dataLanguageFor(extension), extension).not.toEqual([])
		}
	})

	it('leaves an unknown extension plain', () => {
		expect(dataLanguageFor('txt')).toEqual([])
		expect(dataLanguageFor('')).toEqual([])
	})
})
