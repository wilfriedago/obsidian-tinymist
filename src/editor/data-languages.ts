import * as codemirrorLanguage from '@codemirror/language'
import {
	HighlightStyle,
	type Language,
	StreamLanguage,
	type StreamParser,
	type StringStream,
	syntaxHighlighting
} from '@codemirror/language'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { yaml } from '@codemirror/legacy-modes/mode/yaml'
import type { Extension } from '@codemirror/state'

import { tags } from '@lezer/highlight'

/**
 * Highlighting for the files a Typst document reads rather than renders:
 * BibLaTeX and Hayagriva bibliographies, and the data behind `yaml()` and
 * `toml()`, `typst.toml` included.
 *
 * These are stream modes, not Lezer grammars. They need nothing beyond
 * `@codemirror/language`, which Obsidian already supplies, and a file of this
 * kind has no structure worth a syntax tree: no completion or folding reads it.
 */

interface BibtexState {
	/** Inside `@type{…}`, after its opening delimiter. */
	inEntry: boolean
	/** Between `@type` and its opening delimiter. */
	awaitingOpen: boolean
	/** The next word is the citation key. */
	expectingKey: boolean
	/** `@comment{…}` is skipped whole, like text between entries. */
	entryIsComment: boolean
	/** `}` or `)`, whichever matches how the entry opened. */
	close: string
	/** Nesting depth inside a `{…}` value; 0 when not in one. */
	braceDepth: number
	/** Inside a `"…"` value. */
	inQuote: boolean
}

/** Consumes a braced value, across lines, until its braces balance. */
function bracedValue(stream: StringStream, state: BibtexState): void {
	while (!stream.eol()) {
		const ch = stream.next()
		if (ch === '\\') {
			stream.next()
		} else if (ch === '{') {
			state.braceDepth += 1
		} else if (ch === '}') {
			state.braceDepth -= 1
			if (state.braceDepth === 0) {
				return
			}
		}
	}
}

/** Consumes a quoted value. Braces protect quotes: `"a {"} b"` is one value. */
function quotedValue(stream: StringStream, state: BibtexState): void {
	while (!stream.eol()) {
		const ch = stream.next()
		if (ch === '\\') {
			stream.next()
		} else if (ch === '{') {
			state.braceDepth += 1
		} else if (ch === '}') {
			state.braceDepth = Math.max(0, state.braceDepth - 1)
		} else if (ch === '"' && state.braceDepth === 0) {
			state.inQuote = false
			return
		}
	}
}

/**
 * BibTeX and BibLaTeX. There is no maintained CodeMirror mode for either, and
 * the format is small: entries, fields, and values that are braced, quoted,
 * numeric, or a `@string` macro. BibTeX ignores text outside an entry, so that
 * is shown as a comment.
 */
export const bibtex: StreamParser<BibtexState> = {
	name: 'bibtex',
	startState: () => ({
		inEntry: false,
		awaitingOpen: false,
		expectingKey: false,
		entryIsComment: false,
		close: '}',
		braceDepth: 0,
		inQuote: false
	}),
	token(stream, state) {
		if (state.inQuote) {
			quotedValue(stream, state)
			return 'string'
		}
		if (state.braceDepth > 0) {
			bracedValue(stream, state)
			if (state.entryIsComment && state.braceDepth === 0) {
				state.inEntry = false
			}
			return state.entryIsComment ? 'comment' : 'string'
		}
		if (stream.eatSpace()) {
			return null
		}

		if (!state.inEntry && !state.awaitingOpen) {
			if (stream.peek() === '%') {
				stream.skipToEnd()
				return 'comment'
			}
			const type = stream.match(/^@[A-Za-z]+/) as RegExpMatchArray | null
			if (type) {
				const name = type[0].slice(1).toLowerCase()
				state.awaitingOpen = true
				state.entryIsComment = name === 'comment'
				// `@string` and `@preamble` hold a field or a value, not a key.
				state.expectingKey = name !== 'string' && name !== 'preamble' && name !== 'comment'
				return 'keyword'
			}
			if (!stream.skipTo('@')) {
				stream.skipToEnd()
			}
			return 'comment'
		}

		if (state.awaitingOpen) {
			const ch = stream.peek()
			if (ch === '{' || ch === '(') {
				stream.next()
				state.awaitingOpen = false
				state.inEntry = true
				state.close = ch === '{' ? '}' : ')'
				if (state.entryIsComment) {
					state.braceDepth = 1
				}
				return 'bracket'
			}
			// Not an entry after all: `@` followed by anything else is text.
			state.awaitingOpen = false
			stream.next()
			return 'comment'
		}

		// Inside an entry, `%` outside a value comments out the rest of the line,
		// as Typst reads it. Checked first so a comment before the key keeps it.
		if (stream.peek() === '%') {
			stream.skipToEnd()
			return 'comment'
		}

		if (state.expectingKey) {
			state.expectingKey = false
			if (stream.match(/^[^\s,{}()"=#%]+/)) {
				return 'labelName'
			}
		}

		const ch = stream.peek()
		if (ch === state.close) {
			stream.next()
			state.inEntry = false
			return 'bracket'
		}
		if (ch === '{') {
			bracedValue(stream, state)
			return 'string'
		}
		if (ch === '"') {
			stream.next()
			state.inQuote = true
			quotedValue(stream, state)
			return 'string'
		}
		if (ch === '=' || ch === '#') {
			stream.next()
			return 'operator'
		}
		if (ch === ',') {
			stream.next()
			return 'separator'
		}
		if (stream.match(/^\d+\b/)) {
			return 'number'
		}
		if (stream.match(/^[A-Za-z_][\w:.+/-]*/)) {
			// A field name is followed by `=`; anything else is a `@string` macro.
			return stream.match(/^\s*=/, false) ? 'propertyName' : 'variableName'
		}
		stream.next()
		return null
	},
	languageData: {
		commentTokens: { line: '%' }
	}
}

/*
 * Token names are rewritten in `token` rather than through `tokenTable`, which
 * Obsidian's `StreamLanguage` ignores (see `obsidianLineHighlighter`).
 */

/** YAML marks mapping keys as `atom`; shown as properties, like TOML's. */
export const yamlParser: StreamParser<unknown> = {
	...yaml,
	token(stream, state) {
		const style = yaml.token(stream, state)
		return style === 'atom' ? 'propertyName' : style
	}
}

/** TOML marks both `[table]` headers and booleans `atom`; headers get their own. */
export const tomlParser: StreamParser<unknown> = {
	...toml,
	token(stream, state) {
		const style = toml.token(stream, state)
		if (style === 'atom' && stream.current().startsWith('[')) {
			return 'heading'
		}
		return style === 'property' ? 'propertyName' : style
	}
}

/**
 * Obsidian's build of `@codemirror/language` replaces `StreamLanguage`: a token
 * carries its name as a `cm-<name>` class rather than a highlight tag, and the
 * extra export `lineHighlighter` draws those classes. Without it, a stream
 * language parses but stays uncolored, and no `HighlightStyle` can match it.
 * `styles.css` colors the classes. Stock CodeMirror, which the tests run, has
 * no such export and highlights through `dataHighlightStyle` instead.
 */
const obsidianLineHighlighter = (codemirrorLanguage as { lineHighlighter?: Extension }).lineHighlighter

/**
 * Colors from the theme's own code-block palette, so these files look like a
 * fenced block of the same language in a note, in light and dark themes alike.
 * Mirrored by the `cm-<name>` rules in `styles.css`, for Obsidian.
 */
const dataHighlightStyle = HighlightStyle.define([
	{ tag: tags.comment, color: 'var(--code-comment)' },
	{ tag: tags.keyword, color: 'var(--code-keyword)' },
	{ tag: tags.string, color: 'var(--code-string)' },
	{ tag: [tags.number, tags.bool, tags.atom, tags.null], color: 'var(--code-value)' },
	{ tag: tags.propertyName, color: 'var(--code-property)' },
	{ tag: tags.labelName, color: 'var(--code-function)' },
	{ tag: [tags.heading, tags.definition(tags.variableName)], color: 'var(--code-tag)' },
	{ tag: tags.variableName, color: 'var(--code-important)' },
	{ tag: [tags.operator, tags.separator, tags.meta], color: 'var(--code-operator)' },
	{ tag: tags.bracket, color: 'var(--code-punctuation)' }
])

const LANGUAGES: Record<string, Language> = {
	bib: StreamLanguage.define(bibtex),
	yml: StreamLanguage.define(yamlParser),
	yaml: StreamLanguage.define(yamlParser),
	toml: StreamLanguage.define(tomlParser)
}

/** Highlighting for a file with this extension, or nothing for one it does not know. */
export function dataLanguageFor(extension: string): Extension[] {
	const language = LANGUAGES[extension.toLowerCase()]
	if (!language) {
		return []
	}

	const highlighting = [syntaxHighlighting(dataHighlightStyle)]

	if (obsidianLineHighlighter) {
		highlighting.push(obsidianLineHighlighter)
	}

	return [language, highlighting]
}
