import { ItemView, Notice, setIcon, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';

import { TypstError } from '../shared/errors';
import type { Logger } from '../shared/logging';
import type { VaultPath } from '../shared/paths';

export const TYPST_PREVIEW_VIEW_TYPE = 'typst-preview';

/**
 * The Typst preview, as an ordinary Obsidian workspace leaf.
 *
 * The rendered document lives in an iframe pointed at Tinymist's own loopback
 * preview server. That is deliberate isolation rather than convenience: the
 * frame gets a real `http://127.0.0.1:<port>` origin, which is not Obsidian's
 * `app://` origin, so the same-origin policy alone stops rendered content from
 * reaching Obsidian's DOM, its APIs, or the vault. No document-derived markup
 * is ever injected into Obsidian's own page.
 *
 * A `sandbox` attribute is deliberately *not* set: without `allow-same-origin`
 * the frame would get an opaque origin, and the preview frontend's
 * `sessionStorage` access would throw. Cross-origin already gives the isolation
 * that matters.
 */

/**
 * A per-preview theme choice. `null` means "use the plugin setting", which is
 * the default and follows Obsidian's own light/dark mode.
 */
export type PreviewThemeOverride = 'light' | 'dark' | null;

export interface PreviewViewState {
	/** Vault-relative path of the previewed `.typ` document. */
	vaultPath: VaultPath | null;
	/** Per-leaf theme choice, persisted with the workspace. */
	themeOverride?: PreviewThemeOverride;
}

export interface TypstPreviewHost {
	/** Resolves a preview URL, starting a task if needed. */
	resolvePreviewUrl(vaultPath: VaultPath, themeOverride: PreviewThemeOverride): Promise<string>;
	/** The view is closing; release the task for this document. */
	releasePreview(vaultPath: VaultPath): void;
	/** Opens the source document beside this preview. */
	openSource(vaultPath: VaultPath): Promise<void>;
	readonly logger: Logger;
}

export class TypstPreviewView extends ItemView {
	private vaultPath: VaultPath | null = null;
	private themeOverride: PreviewThemeOverride = null;
	private frame: HTMLIFrameElement | null = null;
	private statusEl: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;
	private themeButton: HTMLElement | null = null;
	/** URL the current frame is showing, so an identical render is a no-op. */
	private frameUrl: string | null = null;
	/** Serializes renders; two concurrent ones would build two frames. */
	private rendering: Promise<void> = Promise.resolve();

	constructor(
		leaf: WorkspaceLeaf,
		private readonly host: TypstPreviewHost,
	) {
		super(leaf);
		// A preview follows its document rather than being navigated to.
		this.navigation = false;
	}

	override getViewType(): string {
		return TYPST_PREVIEW_VIEW_TYPE;
	}

	override getIcon(): string {
		return 'book-open';
	}

	override getDisplayText(): string {
		if (!this.vaultPath) {
			return 'Typst preview';
		}
		const name = this.vaultPath.slice(this.vaultPath.lastIndexOf('/') + 1);
		return `Preview: ${name}`;
	}

	/* ---------------------------------------------------------------------- */
	/* Workspace state                                                        */
	/* ---------------------------------------------------------------------- */

	/** Persisted with the workspace, so the leaf survives a restart. */
	override getState(): Record<string, unknown> {
		return {
			...super.getState(),
			vaultPath: this.vaultPath,
			themeOverride: this.themeOverride,
		};
	}

	override async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const requested = state as PreviewViewState | undefined;
		const requestedPath = requested?.vaultPath ?? null;
		const requestedTheme = requested?.themeOverride ?? null;
		await super.setState(state, result);

		const changed = requestedPath !== this.vaultPath || requestedTheme !== this.themeOverride;
		this.vaultPath = requestedPath;
		this.themeOverride = requestedTheme;

		if (changed) {
			await this.render();
		}
	}

	override async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('tinymist-preview-container');

		// The body is created first so the toolbar, which floats above it, is
		// painted on top without needing a stacking-context workaround.
		this.bodyEl = this.contentEl.createDiv({ cls: 'tinymist-preview-body' });
		const toolbar = this.contentEl.createDiv({ cls: 'tinymist-preview-toolbar' });

		const reload = toolbar.createEl('button', {
			cls: 'tinymist-preview-button',
			attr: { 'aria-label': 'Refresh preview' },
		});
		setIcon(reload, 'refresh-cw');
		this.registerDomEvent(reload, 'click', () => {
			void this.render();
		});

		const openSource = toolbar.createEl('button', {
			cls: 'tinymist-preview-button',
			attr: { 'aria-label': 'Open source' },
		});
		setIcon(openSource, 'file-code');
		this.registerDomEvent(openSource, 'click', () => {
			if (this.vaultPath) {
				void this.host.openSource(this.vaultPath);
			}
		});

		const theme = toolbar.createEl('button', { cls: 'tinymist-preview-button' });
		this.themeButton = theme;
		this.registerDomEvent(theme, 'click', () => {
			void this.cycleTheme();
		});
		this.updateThemeButton();

		this.statusEl = toolbar.createDiv({ cls: 'tinymist-preview-status' });

		await this.render();
	}

	override async onClose(): Promise<void> {
		// Releasing here, rather than in the plugin's unload, is what keeps a
		// closed tab from leaving a preview server running.
		if (this.vaultPath) {
			this.host.releasePreview(this.vaultPath);
		}
		this.teardownFrame();
		this.contentEl.empty();
	}

	/* ---------------------------------------------------------------------- */
	/* Rendering                                                              */
	/* ---------------------------------------------------------------------- */

	/**
	 * Points the frame at a fresh preview URL, reporting failures in place.
	 *
	 * Renders are serialized and deduplicated. Obsidian can call `onOpen` and
	 * `setState` in either order, and both want to render, so without this the
	 * frame is torn down and rebuilt against the *same* URL — reloading two
	 * megabytes of preview frontend and re-initializing its WebAssembly for
	 * nothing.
	 */
	async render(): Promise<void> {
		const run = this.rendering.then(() => this.renderOnce());
		// Keep the chain alive even when one render rejects.
		this.rendering = run.catch(() => undefined);
		await run;
	}

	private async renderOnce(): Promise<void> {
		const body = this.bodyEl;
		if (!body) {
			// `setState` can arrive before `onOpen` has built the DOM. The
			// render that follows `onOpen` will do the work.
			return;
		}

		if (!this.vaultPath) {
			this.teardownFrame();
			body.empty();
			this.showMessage('Open a Typst document, then run "Open preview".');
			this.setStatus('');
			return;
		}

		this.setStatus(this.frame ? 'Reloading…' : 'Starting…');

		let url: string;
		try {
			url = await this.host.resolvePreviewUrl(this.vaultPath, this.themeOverride);
		} catch (error) {
			this.teardownFrame();
			body.empty();
			const message =
				error instanceof TypstError ? error.toUserMessage() : 'The preview could not start.';
			this.host.logger.error('Preview failed to start', error);
			this.showMessage(message);
			this.setStatus('Unavailable');
			return;
		}

		// Nothing changed, so leave the frame alone. Reloading it would throw
		// away the rendered document and the reader's scroll position.
		if (this.frame && this.frameUrl === url) {
			this.setStatus('Live');
			return;
		}

		this.teardownFrame();
		body.empty();

		const frame = body.createEl('iframe', { cls: 'tinymist-preview-frame' });
		frame.setAttribute('src', url);
		frame.setAttribute('title', this.getDisplayText());
		// The frame is a separate origin already; referrer and feature access
		// are trimmed anyway so it cannot learn about or use the host.
		frame.setAttribute('referrerpolicy', 'no-referrer');
		frame.setAttribute('allow', '');
		this.frame = frame;
		this.frameUrl = url;

		this.setStatus('Live');
	}

	/** Shows a plain-text message in place of the frame. */
	private showMessage(message: string): void {
		const body = this.bodyEl;
		if (!body) {
			return;
		}
		const panel = body.createDiv({ cls: 'tinymist-preview-message' });
		for (const line of message.split('\n')) {
			// textContent only: the message can carry a compiler string.
			panel.createDiv({ cls: 'tinymist-preview-message-line' }).textContent = line;
		}
	}

	private setStatus(text: string): void {
		if (this.statusEl) {
			this.statusEl.textContent = text;
		}
	}

	private teardownFrame(): void {
		if (this.frame) {
			// Navigating away first stops the frame's websocket immediately
			// rather than at the next GC.
			this.frame.setAttribute('src', 'about:blank');
			this.frame.remove();
			this.frame = null;
		}
		this.frameUrl = null;
	}

	/** Re-points an open preview at a different document. */
	async showDocument(vaultPath: VaultPath): Promise<void> {
		if (this.vaultPath === vaultPath) {
			return;
		}
		if (this.vaultPath) {
			this.host.releasePreview(this.vaultPath);
		}
		this.vaultPath = vaultPath;
		await this.render();
	}

	getPreviewedPath(): VaultPath | null {
		return this.vaultPath;
	}

	/**
	 * Steps the preview's theme: follow the app, then light, then dark.
	 *
	 * Tinymist fixes colour inversion when the preview task starts, so each
	 * step replaces the task. That costs a recompile, which is why this is a
	 * deliberate button press rather than something tied to scrolling.
	 */
	private async cycleTheme(): Promise<void> {
		const next: PreviewThemeOverride =
			this.themeOverride === null ? 'light' : this.themeOverride === 'light' ? 'dark' : null;
		this.themeOverride = next;
		this.updateThemeButton();
		await this.render();
	}

	private updateThemeButton(): void {
		const button = this.themeButton;
		if (!button) {
			return;
		}
		const { icon, label } =
			this.themeOverride === 'light'
				? { icon: 'sun', label: 'Preview theme: light. Select for dark.' }
				: this.themeOverride === 'dark'
					? { icon: 'moon', label: 'Preview theme: dark. Select to follow the app.' }
					: { icon: 'monitor', label: 'Preview theme: follows the app. Select for light.' };

		setIcon(button, icon);
		button.setAttribute('aria-label', label);
	}

	/** Reports a problem without stealing focus from the editor. */
	notifyFailure(message: string): void {
		new Notice(message);
	}
}
