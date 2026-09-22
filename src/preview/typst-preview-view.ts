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

export type PreviewViewState = {
	/** Vault-relative path of the previewed `.typ` document. */
	vaultPath: VaultPath | null;
	/** Per-leaf theme choice, persisted with the workspace. */
	themeOverride?: PreviewThemeOverride;
	/**
	 * Hold this preview on its document instead of following the editor.
	 *
	 * This is the preview's own pin, not Obsidian's tab pinning: it says which
	 * document is rendered, not whether the tab can be navigated away.
	 * `undefined` means "not decided yet", which resolves to the plugin
	 * setting — that is what carries a workspace saved before pinning existed.
	 */
	pinned?: boolean;
};

/**
 * Whether a preview leaf should be re-pointed at the document being edited.
 *
 * Kept pure and separate from the view so the rule can be tested without an
 * Obsidian workspace, and so the runtime can apply it to a leaf whose view has
 * been deferred and is not constructed yet.
 */
export function shouldRetargetPreview(
	state: PreviewViewState | undefined,
	activePath: VaultPath,
	pinnedByDefault: boolean,
): boolean {
	if ((state?.pinned ?? pinnedByDefault) === true) {
		return false;
	}
	return (state?.vaultPath ?? null) !== activePath;
}

export interface TypstPreviewHost {
	/** Resolves a preview URL, starting a task if needed. */
	resolvePreviewUrl(vaultPath: VaultPath, themeOverride: PreviewThemeOverride): Promise<string>;
	/**
	 * This view is done with the document; release its task unless another
	 * preview is still showing it.
	 */
	releasePreview(vaultPath: VaultPath, requester: TypstPreviewView): void;
	/** Whether a preview with no stored choice starts pinned. */
	previewStartsPinned(): boolean;
	/** Opens the source document beside this preview. */
	openSource(vaultPath: VaultPath): Promise<void>;
	readonly logger: Logger;
}

export class TypstPreviewView extends ItemView {
	private vaultPath: VaultPath | null = null;
	private themeOverride: PreviewThemeOverride = null;
	/** Resolved from the setting until the leaf has a choice of its own. */
	private pinned = false;
	private frame: HTMLIFrameElement | null = null;
	private statusEl: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;
	private themeButton: HTMLElement | null = null;
	private pinButton: HTMLElement | null = null;
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
		// The setting decides until the leaf's own stored choice arrives in
		// `setState` — which is not guaranteed to happen before `onOpen` builds
		// the toolbar, so the button would otherwise start out lying.
		this.pinned = host.previewStartsPinned();
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
			pinned: this.pinned,
		};
	}

	/**
	 * The only way a preview changes document.
	 *
	 * Going through the leaf's state rather than mutating the view keeps the
	 * tab header, the workspace file, and the view in step — Obsidian updates
	 * the header off a state change, and there is no public API to ask it to.
	 */
	override async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const requested = state as PreviewViewState | undefined;
		const requestedPath = requested?.vaultPath ?? null;
		const requestedTheme = requested?.themeOverride ?? null;
		// A leaf restored from a workspace saved before pinning existed has no
		// stored choice, so the setting decides for it.
		const requestedPin = requested?.pinned ?? this.host.previewStartsPinned();
		await super.setState(state, result);

		const previousPath = this.vaultPath;
		const needsRender =
			requestedPath !== previousPath || requestedTheme !== this.themeOverride;

		this.vaultPath = requestedPath;
		this.themeOverride = requestedTheme;
		this.pinned = requestedPin;
		this.updatePinButton();

		// Following the editor would otherwise leave a preview server running
		// for every document visited.
		if (previousPath !== null && previousPath !== requestedPath) {
			this.host.releasePreview(previousPath, this);
		}

		if (needsRender) {
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
			this.report('Refreshing the preview failed', this.render());
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

		const pin = toolbar.createEl('button', { cls: 'tinymist-preview-button' });
		this.pinButton = pin;
		setIcon(pin, 'pin');
		this.registerDomEvent(pin, 'click', () => {
			this.report('Saving the preview pin failed', this.togglePin());
		});
		this.updatePinButton();

		const theme = toolbar.createEl('button', { cls: 'tinymist-preview-button' });
		this.themeButton = theme;
		this.registerDomEvent(theme, 'click', () => {
			this.report('Changing the preview theme failed', this.cycleTheme());
		});
		this.updateThemeButton();

		this.statusEl = toolbar.createDiv({ cls: 'tinymist-preview-status' });

		await this.render();
	}

	override async onClose(): Promise<void> {
		// Releasing here, rather than in the plugin's unload, is what keeps a
		// closed tab from leaving a preview server running.
		if (this.vaultPath) {
			this.host.releasePreview(this.vaultPath, this);
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

		// Captured, because starting a task is slow enough for the document to
		// change underneath it.
		const path = this.vaultPath;

		if (!path) {
			this.teardownFrame();
			body.empty();
			this.showMessage('Open a Typst document, then run "Open preview".');
			this.setStatus('');
			return;
		}

		this.setStatus(this.frame ? 'Reloading…' : 'Starting…');

		let url: string;
		try {
			url = await this.host.resolvePreviewUrl(path, this.themeOverride);
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

		// The document moved on while the task was starting. `setState` already
		// tried to release this one and could not: the task was still being
		// created, so the controller had nothing under that path to stop yet.
		// Without this the server stays up with no view showing it.
		if (this.vaultPath !== path) {
			this.host.releasePreview(path, this);
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

	getPreviewedPath(): VaultPath | null {
		return this.vaultPath;
	}

	/**
	 * Holds this preview on its document, or lets it follow the editor again.
	 *
	 * Releasing the pin retargets nothing by itself; the next document switch
	 * does that, which keeps a click from recompiling something the reader is
	 * still looking at.
	 */
	private async togglePin(): Promise<void> {
		this.pinned = !this.pinned;
		this.updatePinButton();
		await this.persistState();
	}

	private updatePinButton(): void {
		const button = this.pinButton;
		if (!button) {
			return;
		}
		button.toggleClass('is-active', this.pinned);
		button.setAttribute(
			'aria-label',
			this.pinned
				? 'Pinned to this document. Select to follow the editor.'
				: 'Following the editor. Select to pin this document.',
		);
		button.setAttribute('aria-pressed', String(this.pinned));
	}

	/**
	 * Writes the leaf's state to the workspace file.
	 *
	 * Obsidian saves the layout on its own schedule, so without this a toolbar
	 * choice made just before a quit is lost.
	 */
	private async persistState(): Promise<void> {
		await this.app.workspace.requestSaveLayout();
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
		await this.persistState();
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

	/**
	 * Logs a rejected toolbar action instead of letting it escape.
	 *
	 * A DOM handler cannot await, and a bare `void` on a promise that rejects
	 * becomes an unhandled rejection in the console with no clue as to which
	 * button caused it. These failures are not worth a notice — the frame
	 * reports its own trouble in place — but they are worth a log line that
	 * names the action.
	 */
	private report(what: string, action: Promise<void>): void {
		void action.catch((error: unknown) => {
			this.host.logger.error(what, error);
		});
	}

	/** Reports a problem without stealing focus from the editor. */
	notifyFailure(message: string): void {
		new Notice(message);
	}
}
