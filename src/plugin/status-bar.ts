import { setIcon } from 'obsidian';

import type { DiagnosticsSnapshot } from '../typst/diagnostics/store';
import type { TinymistState } from '../typst/tinymist/manager';

/**
 * A single unobtrusive status-bar item.
 *
 * It is the plugin's normal channel for state: notices are reserved for things
 * the user asked for or must act on, so a compile that fails simply turns the
 * indicator red rather than interrupting typing.
 */

export type CompilePhase = 'idle' | 'compiling' | 'success' | 'error';

export interface StatusModel {
	readonly serverState: TinymistState['kind'];
	readonly compilePhase: CompilePhase;
	readonly diagnostics: DiagnosticsSnapshot;
	/** True when a `.typ` document is the active editor. */
	readonly hasActiveDocument: boolean;
}

export interface StatusPresentation {
	readonly text: string;
	readonly icon: string;
	readonly tooltip: string;
	readonly modifier: 'ok' | 'busy' | 'warn' | 'error' | 'off';
}

/** Pure, so the wording is testable without a DOM. */
export function presentStatus(model: StatusModel): StatusPresentation {
	switch (model.serverState) {
		case 'stopped':
			return {
				text: 'Typst: off',
				icon: 'circle-slash',
				tooltip: 'Tinymist is not running. Open a Typst document to start it.',
				modifier: 'off',
			};
		case 'starting':
			return {
				text: 'Typst: starting',
				icon: 'loader',
				tooltip: 'Tinymist is starting.',
				modifier: 'busy',
			};
		case 'failed':
			return {
				text: 'Typst: unavailable',
				icon: 'alert-triangle',
				tooltip: 'Tinymist could not start. Select to open the plugin settings.',
				modifier: 'error',
			};
		case 'crashed':
			return {
				text: 'Typst: disconnected',
				icon: 'plug-zap',
				tooltip: 'Tinymist stopped unexpectedly. Select to restart it.',
				modifier: 'error',
			};
		case 'ready':
			break;
	}

	if (model.compilePhase === 'compiling') {
		return {
			text: 'Typst: compiling',
			icon: 'loader',
			tooltip: 'Compiling the document.',
			modifier: 'busy',
		};
	}

	const { errors, warnings, total } = model.diagnostics;
	if (total > 0) {
		return {
			text: `Typst: ${describeCounts(errors, warnings)}`,
			icon: errors > 0 ? 'alert-circle' : 'alert-triangle',
			tooltip: 'Select to show the diagnostics for this document.',
			modifier: errors > 0 ? 'error' : 'warn',
		};
	}

	return {
		text: 'Typst: ready',
		icon: 'check-circle',
		tooltip: model.hasActiveDocument
			? 'The document compiles without problems.'
			: 'Tinymist is running.',
		modifier: 'ok',
	};
}

function describeCounts(errors: number, warnings: number): string {
	const parts: string[] = [];
	if (errors > 0) {
		parts.push(`${errors} ${errors === 1 ? 'error' : 'errors'}`);
	}
	if (warnings > 0) {
		parts.push(`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`);
	}
	return parts.join(', ');
}

/** Renders {@link presentStatus} into an Obsidian status-bar element. */
export class StatusBarItem {
	private readonly iconEl: HTMLElement;
	private readonly textEl: HTMLElement;
	private currentModifier: string | null = null;

	constructor(private readonly containerEl: HTMLElement) {
		containerEl.addClass('tinymist-status');
		this.iconEl = containerEl.createSpan({ cls: 'tinymist-status-icon' });
		this.textEl = containerEl.createSpan({ cls: 'tinymist-status-text' });
	}

	update(model: StatusModel): void {
		const presentation = presentStatus(model);

		setIcon(this.iconEl, presentation.icon);
		this.textEl.textContent = presentation.text;
		this.containerEl.setAttribute('aria-label', presentation.tooltip);

		if (this.currentModifier) {
			this.containerEl.removeClass(`tinymist-status-${this.currentModifier}`);
		}
		this.containerEl.addClass(`tinymist-status-${presentation.modifier}`);
		this.currentModifier = presentation.modifier;
	}
}
