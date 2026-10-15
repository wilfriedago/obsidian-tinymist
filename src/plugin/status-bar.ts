import { setIcon } from 'obsidian'

import type { DiagnosticsSnapshot } from '../typst/diagnostics/store'
import type { TinymistState } from '../typst/tinymist/manager'
import type { WordsCount } from '../typst/tinymist/protocol'

/**
 * A single unobtrusive status-bar item.
 *
 * It is the plugin's normal channel for state: notices are reserved for things
 * the user asked for or must act on, so a compile that fails simply turns the
 * indicator red rather than interrupting typing.
 */

export type CompilePhase = 'idle' | 'compiling' | 'success' | 'error'

export interface StatusModel {
	readonly serverState: TinymistState['kind']
	readonly compilePhase: CompilePhase
	readonly diagnostics: DiagnosticsSnapshot
	/** True when a `.typ` document is the active editor. */
	readonly hasActiveDocument: boolean
	/** The last count Tinymist reported, or null before the first one. */
	readonly wordCount: WordsCount | null
}

export interface StatusPresentation {
	readonly text: string
	readonly icon: string
	readonly tooltip: string
	readonly modifier: 'ok' | 'busy' | 'warn' | 'error' | 'off'
	/** Empty when there is no count to show. */
	readonly wordCount: string
}

/** Pure, so the wording is testable without a DOM. */
export function presentStatus(model: StatusModel): StatusPresentation {
	const wordCount = model.serverState === 'ready' && model.hasActiveDocument && model.wordCount ? describeWordCount(model.wordCount) : ''
	return { ...presentState(model), wordCount }
}

function presentState(model: StatusModel): Omit<StatusPresentation, 'wordCount'> {
	switch (model.serverState) {
		case 'stopped':
			return {
				text: 'Typst: off',
				icon: 'circle-slash',
				tooltip: 'Tinymist is not running. Open a Typst document to start it.',
				modifier: 'off'
			}
		case 'starting':
			return {
				text: 'Typst: starting',
				icon: 'loader',
				tooltip: 'Tinymist is starting.',
				modifier: 'busy'
			}
		case 'failed':
			return {
				text: 'Typst: unavailable',
				icon: 'alert-triangle',
				tooltip: 'Tinymist could not start. Select to open the plugin settings.',
				modifier: 'error'
			}
		case 'crashed':
			return {
				text: 'Typst: disconnected',
				icon: 'plug-zap',
				tooltip: 'Tinymist stopped unexpectedly. Select to restart it.',
				modifier: 'error'
			}
		case 'ready':
			break
	}

	if (model.compilePhase === 'compiling') {
		return {
			text: 'Typst: compiling',
			icon: 'loader',
			tooltip: 'Compiling the document.',
			modifier: 'busy'
		}
	}

	const { errors, warnings, total } = model.diagnostics
	if (total > 0) {
		return {
			text: `Typst: ${describeCounts(errors, warnings)}`,
			icon: errors > 0 ? 'alert-circle' : 'alert-triangle',
			tooltip: 'Select to show the diagnostics for this document.',
			modifier: errors > 0 ? 'error' : 'warn'
		}
	}

	return {
		text: 'Typst: ready',
		icon: 'circle-check',
		tooltip: model.hasActiveDocument ? 'The document compiles without problems.' : 'Tinymist is running.',
		modifier: 'ok'
	}
}

const numberFormat = new Intl.NumberFormat('en-US')

export function describeWordCount(count: WordsCount): string {
	return [
		plural(count.words, 'word'),
		plural(count.chars, 'char'),
		plural(count.spaces, 'space'),
		plural(count.cjkChars, 'CJK char')
	].join(' · ')
}

function plural(n: number, noun: string): string {
	return `${numberFormat.format(n)} ${noun}${n === 1 ? '' : 's'}`
}

function describeCounts(errors: number, warnings: number): string {
	const parts: string[] = []
	if (errors > 0) {
		parts.push(`${errors} ${errors === 1 ? 'error' : 'errors'}`)
	}
	if (warnings > 0) {
		parts.push(`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`)
	}
	return parts.join(', ')
}

/** On `body` while a Typst document is the active editor. */
const TYPST_ACTIVE_CLASS = 'tinymist-typst-active'

/** Renders {@link presentStatus} into an Obsidian status-bar element. */
export class StatusBarItem {
	private readonly iconEl: HTMLElement
	private readonly textEl: HTMLElement
	private readonly wordCountEl: HTMLElement
	private currentModifier: string | null = null

	constructor(private readonly containerEl: HTMLElement) {
		containerEl.addClass('tinymist-status')
		this.iconEl = containerEl.createSpan({ cls: 'tinymist-status-icon' })
		this.textEl = containerEl.createSpan({ cls: 'tinymist-status-text' })
		this.wordCountEl = containerEl.createSpan({ cls: 'tinymist-status-word-count' })
	}

	update(model: StatusModel): void {
		const presentation = presentStatus(model)

		setIcon(this.iconEl, presentation.icon)
		this.textEl.textContent = presentation.text
		this.wordCountEl.textContent = presentation.wordCount
		this.wordCountEl.toggle(presentation.wordCount !== '')
		this.containerEl.setAttribute('aria-label', presentation.tooltip)
		// Lets the stylesheet hide Obsidian's own word count and backlinks, which
		// only understand Markdown and would show a stale or wrong figure here.
		// The status bar's own window, not the global `document`, which a popout
		// would not share.
		this.containerEl.doc.body.toggleClass(TYPST_ACTIVE_CLASS, model.hasActiveDocument)

		if (this.currentModifier) {
			this.containerEl.removeClass(`tinymist-status-${this.currentModifier}`)
		}
		this.containerEl.addClass(`tinymist-status-${presentation.modifier}`)
		this.currentModifier = presentation.modifier
	}

	/** Gives Obsidian its status bar items back once the plugin unloads. */
	detach(): void {
		this.containerEl.doc.body.removeClass(TYPST_ACTIVE_CLASS)
	}
}
