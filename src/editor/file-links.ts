import { syntaxTree } from '@codemirror/language'
import { Facet, StateEffect, StateField, type EditorState, type Extension, type Text } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type PluginValue, type ViewUpdate } from '@codemirror/view'

import { Notice, Platform } from 'obsidian'

import { LogSink, Logger } from '../shared/logging'
import type { ServerCapabilities } from '../typst/tinymist/client'
import type { DocumentLink, Location, LocationLink, Position } from '../typst/tinymist/protocol'
import type { LanguageFeatureContext } from './language-features'
import { offsetToPosition, rangeToOffsets } from './positions'

/**
 * Following a path in a Typst document to the file it names: Mod-click opens
 * it in place of this document, Mod-Shift-click in a new tab.
 *
 * Tinymist does the resolving. Typst's rules for a path — relative to the file,
 * or to the project root when it starts with `/`, and never above that root —
 * are its rules, and reimplementing them here would drift. Two requests
 * between them cover what a document points at:
 *
 *   `textDocument/documentLink`  the paths in `image`, `#include`,
 *                                `#bibliography`, `read`, `yaml`, …
 *   `textDocument/definition`    `#import "file.typ"`, which the links leave out
 *
 * Only a string literal is ever followed by `definition`. On an identifier the
 * same request is go-to-definition, which is a different feature.
 *
 * `toml("…")` is resolved by neither, at Tinymist 0.15.8, so it does not open.
 */

export interface FileLinkContext extends LanguageFeatureContext {
	/** Opens the file a link resolved to; `newTab` keeps this document open. */
	openLinkedFile(uri: string, newTab: boolean): void
}

/** A path in the buffer, and the `file:` URI Tinymist resolved it to. */
export interface FileLink {
	readonly from: number
	readonly to: number
	/** Empty when Tinymist recognised a path but could not resolve it. */
	readonly target: string
}

export type LinkPlacement = 'here' | 'tab'

interface ModifierState {
	readonly metaKey: boolean
	readonly ctrlKey: boolean
	readonly altKey: boolean
	readonly shiftKey: boolean
}

/**
 * Where a click with these modifiers opens a link, or `null` when it is not a
 * link click at all.
 *
 * Mod is Cmd on macOS, where Ctrl-click is a right-click, and Ctrl elsewhere.
 * Alt is left alone: with Mod it is CodeMirror's rectangular selection.
 */
export function linkPlacement(event: ModifierState & { readonly button?: number }, isMacOS: boolean): LinkPlacement | null {
	if ((event.button ?? 0) !== 0 || !isModHeld(event, isMacOS) || event.altKey) {
		return null
	}
	return event.shiftKey ? 'tab' : 'here'
}

function isModHeld(event: ModifierState, isMacOS: boolean): boolean {
	return isMacOS ? event.metaKey : event.ctrlKey
}

/** The string literal around `pos`, quotes included, or `null` outside one. */
export function stringLiteralAt(state: EditorState, pos: number): { from: number; to: number } | null {
	const innermost = syntaxTree(state).resolveInner(pos, 1)
	for (let node: typeof innermost | null = innermost; node; node = node.parent) {
		if (node.name === 'Str') {
			return { from: node.from, to: node.to }
		}
	}
	return null
}

export function linkAt(links: readonly FileLink[], pos: number): FileLink | null {
	return links.find((link) => link.from <= pos && pos <= link.to) ?? null
}

/** Converts a `textDocument/documentLink` response, keeping only local files. */
export function toFileLinks(doc: Text, response: readonly DocumentLink[] | null): FileLink[] {
	const links: FileLink[] = []
	for (const link of response ?? []) {
		const target = link.target ?? ''
		// Tinymist reports a path it cannot resolve, such as one above the
		// project root, with an empty target. Kept, so a click on it can say
		// so rather than doing nothing.
		if (target !== '' && !target.startsWith('file:')) {
			continue
		}
		links.push({ ...rangeToOffsets(doc, link.range), target })
	}
	return links
}

/**
 * Converts a `textDocument/definition` response for a position inside
 * `literal` into a link covering the path between its quotes.
 */
export function definitionLink(
	literal: { from: number; to: number },
	response: Location | readonly (Location | LocationLink)[] | null
): FileLink | null {
	const first = Array.isArray(response) ? response[0] : response
	if (!first) {
		return null
	}
	const target = 'targetUri' in first ? first.targetUri : first.uri
	if (!target.startsWith('file:')) {
		return null
	}
	return { from: literal.from + 1, to: Math.max(literal.from + 1, literal.to - 1), target }
}

/* -------------------------------------------------------------------------- */
/* Extension                                                                  */
/* -------------------------------------------------------------------------- */

const setHighlight = StateEffect.define<{ from: number; to: number } | null>()

const linkMark = Decoration.mark({ class: 'tinymist-file-link' })

/** The path under the pointer while Mod is held, underlined. */
const highlightField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(decorations, transaction) {
		// An edit can move the path out from under the mark; the next mouse
		// move puts it back where it belongs.
		let next = transaction.docChanged ? Decoration.none : decorations
		for (const effect of transaction.effects) {
			if (effect.is(setHighlight)) {
				next =
					effect.value && effect.value.to > effect.value.from
						? Decoration.set([linkMark.range(effect.value.from, effect.value.to)])
						: Decoration.none
			}
		}
		return next
	},
	provide: (field) => EditorView.decorations.from(field)
})

type Resolution = { readonly link: FileLink } | { readonly failure: string }

class FileLinkPlugin implements PluginValue {
	/** Everything cached belongs to this exact document; an edit drops it. */
	private doc: Text
	private links: Promise<FileLink[]> | null = null
	private settledLinks: FileLink[] | null = null
	private readonly definitions = new Map<number, Promise<FileLink | null>>()

	private highlighted: { from: number; to: number } | null = null
	private hoverRequest = 0
	private pointer: { x: number; y: number } | null = null

	private readonly context: FileLinkContext

	constructor(private readonly view: EditorView) {
		this.doc = view.state.doc
		this.context = view.state.facet(fileLinkContext)
	}

	update(update: ViewUpdate): void {
		if (update.docChanged) {
			this.doc = update.state.doc
			this.links = null
			this.settledLinks = null
			this.definitions.clear()
			this.highlighted = null
		}
	}

	destroy(): void {
		this.hoverRequest += 1
	}

	/* ---------------------------------------------------------------------- */
	/* Events                                                                 */
	/* ---------------------------------------------------------------------- */

	onMouseDown(event: MouseEvent): boolean {
		const placement = linkPlacement(event, Platform.isMacOS)
		if (placement === null) {
			return false
		}
		const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY }, false)
		if (pos === null || !this.mayBeLink(pos)) {
			// Mod-click elsewhere keeps CodeMirror's meaning: another cursor.
			return false
		}

		event.preventDefault()
		void this.follow(pos, placement)
		return true
	}

	onMouseMove(event: MouseEvent): void {
		this.pointer = { x: event.clientX, y: event.clientY }
		if (isModHeld(event, Platform.isMacOS) && !event.altKey) {
			void this.highlightAt(this.pointer)
		} else {
			this.clearHighlight()
		}
	}

	onKey(event: KeyboardEvent): void {
		const modKey = Platform.isMacOS ? 'Meta' : 'Control'
		if (event.key !== modKey) {
			return
		}
		if (event.type === 'keydown' && this.pointer) {
			void this.highlightAt(this.pointer)
		} else {
			this.clearHighlight()
		}
	}

	onMouseLeave(): void {
		this.pointer = null
		this.clearHighlight()
	}

	/* ---------------------------------------------------------------------- */
	/* Following and highlighting                                             */
	/* ---------------------------------------------------------------------- */

	async follow(pos: number, placement: LinkPlacement): Promise<void> {
		const resolution = await this.resolve(pos)
		if ('failure' in resolution) {
			new Notice(resolution.failure)
			return
		}
		this.context.openLinkedFile(resolution.link.target, placement === 'tab')
	}

	private async highlightAt(pointer: { x: number; y: number }): Promise<void> {
		const request = ++this.hoverRequest
		const pos = this.view.posAtCoords(pointer, false)
		if (pos === null || !this.mayBeLink(pos)) {
			this.clearHighlight()
			return
		}

		const resolution = await this.resolve(pos)
		if (request !== this.hoverRequest) {
			// The pointer moved on, or the modifier was released, meanwhile.
			return
		}
		if ('link' in resolution && resolution.link.target !== '') {
			this.setHighlight({ from: resolution.link.from, to: resolution.link.to })
		} else {
			this.clearHighlight()
		}
	}

	private clearHighlight(): void {
		this.hoverRequest += 1
		this.setHighlight(null)
	}

	private setHighlight(range: { from: number; to: number } | null): void {
		const current = this.highlighted
		if (current === range || (current && range && current.from === range.from && current.to === range.to)) {
			return
		}
		this.highlighted = range
		this.view.dispatch({ effects: setHighlight.of(range) })
	}

	/**
	 * Whether a click here should be claimed before Tinymist has answered.
	 * Every path Tinymist links is a string literal, so outside one it never is.
	 */
	mayBeLink(pos: number): boolean {
		if (this.settledLinks && linkAt(this.settledLinks, pos)) {
			return true
		}
		return stringLiteralAt(this.view.state, pos) !== null
	}

	private async resolve(pos: number): Promise<Resolution> {
		const client = this.context.getClient()
		const uri = this.context.getDocumentUri()
		if (!client || !uri) {
			return { failure: 'Tinymist is not running, so the path cannot be followed' }
		}

		const doc = this.doc
		const link = linkAt(await this.documentLinks(), pos) ?? (await this.importLink(pos))
		if (doc !== this.doc) {
			return { failure: 'The document changed before the path was resolved' }
		}
		if (!link) {
			return { failure: 'No file is linked here' }
		}
		if (link.target === '') {
			return { failure: 'Tinymist could not resolve this path' }
		}
		return { link }
	}

	private documentLinks(): Promise<FileLink[]> {
		if (!this.links) {
			const doc = this.doc
			this.links = this.request<DocumentLink[]>('documentLinkProvider', 'textDocument/documentLink', null).then((response) => {
				const links = toFileLinks(doc, response)
				if (doc === this.doc) {
					this.settledLinks = links
				}
				return links
			})
		}
		return this.links
	}

	private importLink(pos: number): Promise<FileLink | null> {
		const literal = stringLiteralAt(this.view.state, pos)
		if (!literal) {
			return Promise.resolve(null)
		}

		let pending = this.definitions.get(literal.from)
		if (!pending) {
			pending = this.request<Location | (Location | LocationLink)[]>(
				'definitionProvider',
				'textDocument/definition',
				offsetToPosition(this.doc, pos)
			).then((response) => definitionLink(literal, response))
			this.definitions.set(literal.from, pending)
		}
		return pending
	}

	/** One request against this document, or `null` when it cannot be made. */
	private async request<T>(capability: keyof ServerCapabilities, method: string, position: Position | null): Promise<T | null> {
		const client = this.context.getClient()
		const uri = this.context.getDocumentUri()
		if (!client || !uri || !client.supportsCapability(capability)) {
			return null
		}
		try {
			return await client.request<T | null>(method, { textDocument: { uri }, ...(position ? { position } : {}) }, 6_000)
		} catch (error) {
			this.context.logger.debug(`${method} failed`, error)
			return null
		}
	}
}

/**
 * Handed in through a facet rather than captured, so {@link followLinkAtCursor}
 * can find the plugin instance from nothing but the view.
 */
const fileLinkContext = Facet.define<FileLinkContext, FileLinkContext>({
	// Never used: the plugin is only ever added alongside a context.
	combine: (values) =>
		values[0] ?? {
			getClient: () => null,
			getDocumentUri: () => null,
			openLinkedFile: () => undefined,
			logger: new Logger(new LogSink(), 'file-links')
		}
})

const fileLinkPlugin = ViewPlugin.define((view) => new FileLinkPlugin(view), {
	eventHandlers: {
		mousedown(event) {
			return this.onMouseDown(event)
		},
		mousemove(event) {
			this.onMouseMove(event)
		},
		mouseleave() {
			this.onMouseLeave()
		},
		keydown(event) {
			this.onKey(event)
		},
		keyup(event) {
			this.onKey(event)
		}
	}
})

export function createFileLinkExtension(context: FileLinkContext): Extension {
	return [fileLinkContext.of(context), highlightField, fileLinkPlugin]
}

/**
 * Follows the path under the cursor, as Mod-click on it would: the keyboard's
 * way to the same place. With `checking`, only reports whether the cursor is
 * on something that may be a path, for a command's `checkCallback`.
 */
export function followLinkAtCursor(view: EditorView, placement: LinkPlacement, checking: boolean): boolean {
	const plugin = view.plugin(fileLinkPlugin)
	const pos = view.state.selection.main.head
	if (!plugin || !plugin.mayBeLink(pos)) {
		return false
	}
	if (!checking) {
		void plugin.follow(pos, placement)
	}
	return true
}
