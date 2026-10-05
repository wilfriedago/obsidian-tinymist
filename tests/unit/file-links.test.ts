import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState, Text } from '@codemirror/state'

import { typst_lezer } from 'codemirror-lang-typst/lezer'
import { TFile, type App, type WorkspaceLeaf } from 'obsidian'
import { beforeEach, describe, expect, it } from 'vitest'

import { definitionLink, linkAt, linkPlacement, stringLiteralAt, toFileLinks } from '../../src/editor/file-links'
import { openLinkedFile } from '../../src/plugin/linked-files'
// The stub `obsidian` resolves to at runtime, read directly for what it records.
import { Notice } from '../helpers/obsidian-stub'

const click = (modifiers: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; button: number }>) => ({
	metaKey: false,
	ctrlKey: false,
	altKey: false,
	shiftKey: false,
	button: 0,
	...modifiers
})

describe('linkPlacement', () => {
	it('opens in place with Mod, and in a new tab with Mod-Shift', () => {
		expect(linkPlacement(click({ ctrlKey: true }), false)).toBe('here')
		expect(linkPlacement(click({ ctrlKey: true, shiftKey: true }), false)).toBe('tab')
		expect(linkPlacement(click({ metaKey: true }), true)).toBe('here')
		expect(linkPlacement(click({ metaKey: true, shiftKey: true }), true)).toBe('tab')
	})

	it('uses Cmd on macOS, where Ctrl-click is a right-click', () => {
		expect(linkPlacement(click({ ctrlKey: true }), true)).toBeNull()
		expect(linkPlacement(click({ metaKey: true }), false)).toBeNull()
	})

	it('leaves plain clicks, Shift-clicks, and other buttons alone', () => {
		expect(linkPlacement(click({}), false)).toBeNull()
		expect(linkPlacement(click({ shiftKey: true }), false)).toBeNull()
		expect(linkPlacement(click({ ctrlKey: true, button: 1 }), false)).toBeNull()
	})

	it('leaves Mod-Alt to rectangular selection', () => {
		expect(linkPlacement(click({ ctrlKey: true, altKey: true }), false)).toBeNull()
	})
})

describe('stringLiteralAt', () => {
	const source = '#import "a.typ": x\n#image("b.png")\n= Head "quoted"\n#let n = 1'
	const state = EditorState.create({ doc: source, extensions: [typst_lezer()] })
	ensureSyntaxTree(state, source.length, 5_000)
	const at = (needle: string, offset = 1) => stringLiteralAt(state, source.indexOf(needle) + offset)

	it('finds the literal, quotes included, anywhere inside it', () => {
		const from = source.indexOf('"b.png"')
		expect(at('"b.png"', 0)).toEqual({ from, to: from + 7 })
		expect(at('b.png')).toEqual({ from, to: from + 7 })
		expect(at('"a.typ"', 3)).toEqual({ from: source.indexOf('"a.typ"'), to: source.indexOf('"a.typ"') + 7 })
	})

	it('is null outside a string, including quoted markup', () => {
		expect(at('image')).toBeNull()
		expect(at(': x', 2)).toBeNull()
		expect(at('quoted')).toBeNull()
		expect(at('1', 0)).toBeNull()
	})
})

describe('toFileLinks', () => {
	const doc = Text.of(['#image("b.png")', '#image("../../c.png")', '#link("https://typst.app")'])
	const range = (line: number, start: number, end: number) => ({ start: { line, character: start }, end: { line, character: end } })

	it('maps ranges to offsets and keeps local files', () => {
		const links = toFileLinks(doc, [{ range: range(0, 8, 13), target: 'file:///v/b.png' }])
		expect(links).toEqual([{ from: 8, to: 13, target: 'file:///v/b.png' }])
		expect(linkAt(links, 8)).toEqual(links[0])
		expect(linkAt(links, 13)).toEqual(links[0])
		expect(linkAt(links, 14)).toBeNull()
	})

	it('keeps a path Tinymist could not resolve, with an empty target', () => {
		// Tinymist answers a path above the project root this way.
		expect(toFileLinks(doc, [{ range: range(1, 8, 19), target: '' }])).toEqual([{ from: 24, to: 35, target: '' }])
		expect(toFileLinks(doc, [{ range: range(1, 8, 19) }])).toEqual([{ from: 24, to: 35, target: '' }])
	})

	it('drops anything that is not a local file', () => {
		expect(toFileLinks(doc, [{ range: range(2, 7, 24), target: 'https://typst.app' }])).toEqual([])
		expect(toFileLinks(doc, null)).toEqual([])
	})
})

describe('definitionLink', () => {
	const literal = { from: 8, to: 15 }
	const zero = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }

	it('covers the path between the quotes', () => {
		expect(definitionLink(literal, [{ targetUri: 'file:///v/a.typ', targetRange: zero, targetSelectionRange: zero }])).toEqual({
			from: 9,
			to: 14,
			target: 'file:///v/a.typ'
		})
	})

	it('accepts a plain Location, alone or in a list', () => {
		expect(definitionLink(literal, { uri: 'file:///v/a.typ', range: zero })?.target).toBe('file:///v/a.typ')
		expect(definitionLink(literal, [{ uri: 'file:///v/a.typ', range: zero }])?.target).toBe('file:///v/a.typ')
	})

	it('is null when nothing, or nothing local, is found', () => {
		expect(definitionLink(literal, null)).toBeNull()
		expect(definitionLink(literal, [])).toBeNull()
		expect(definitionLink(literal, { uri: 'untitled:a.typ', range: zero })).toBeNull()
	})
})

describe('openLinkedFile', () => {
	const VAULT = '/Users/x/vault'

	interface Opened {
		leaf: string
		path: string
	}

	const fakeApp = (paths: string[], opened: Opened[]) => {
		const leaf = (name: string) => ({
			openFile: async (file: TFile) => {
				opened.push({ leaf: name, path: file.path })
			}
		})
		const app = {
			vault: {
				getFileByPath: (path: string) => {
					if (!paths.includes(path)) return null
					const file = new TFile()
					file.path = path
					return file
				}
			},
			workspace: { getLeaf: (type: unknown) => leaf(type === 'tab' ? 'new tab' : `getLeaf(${String(type)})`) }
		}
		return { app: app as unknown as App, source: leaf('source') as unknown as WorkspaceLeaf }
	}

	beforeEach(() => {
		Notice.shown.length = 0
	})

	it('opens in the leaf the link was followed from', async () => {
		const opened: Opened[] = []
		const { app, source } = fakeApp(['papers/fig.svg'], opened)
		await openLinkedFile(app, VAULT, 'file:///Users/x/vault/papers/fig.svg', source)
		expect(opened).toEqual([{ leaf: 'source', path: 'papers/fig.svg' }])
		expect(Notice.shown).toEqual([])
	})

	it('opens in a new tab', async () => {
		const opened: Opened[] = []
		const { app } = fakeApp(['refs.bib'], opened)
		await openLinkedFile(app, VAULT, 'file:///Users/x/vault/refs.bib', 'tab')
		expect(opened).toEqual([{ leaf: 'new tab', path: 'refs.bib' }])
	})

	it('decodes the URI before looking the file up', async () => {
		const opened: Opened[] = []
		const { app, source } = fakeApp(['my notes/café.typ'], opened)
		await openLinkedFile(app, VAULT, 'file:///Users/x/vault/my%20notes/caf%C3%A9.typ', source)
		expect(opened).toEqual([{ leaf: 'source', path: 'my notes/café.typ' }])
	})

	it('says so, rather than doing nothing, for a file outside the vault', async () => {
		const opened: Opened[] = []
		const { app, source } = fakeApp([], opened)
		await openLinkedFile(app, VAULT, 'file:///Users/x/elsewhere/fig.svg', source)
		expect(opened).toEqual([])
		expect(Notice.shown).toEqual(['/Users/x/elsewhere/fig.svg is outside the vault'])
	})

	it('says so for a path that does not exist', async () => {
		const opened: Opened[] = []
		const { app, source } = fakeApp([], opened)
		await openLinkedFile(app, VAULT, 'file:///Users/x/vault/missing.png', source)
		expect(opened).toEqual([])
		expect(Notice.shown).toEqual(['missing.png does not exist'])
	})

	it('refuses anything that is not a local file', async () => {
		const opened: Opened[] = []
		const { app, source } = fakeApp([], opened)
		await openLinkedFile(app, VAULT, 'https://typst.app', source)
		expect(opened).toEqual([])
		expect(Notice.shown).toEqual(['Only files on this device can be opened'])
	})
})
