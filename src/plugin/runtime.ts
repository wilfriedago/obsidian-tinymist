import { Notice, TFile, type App, type Plugin, type TFolder, type WorkspaceLeaf } from 'obsidian';

import { BibliographyEditorView, BIBLIOGRAPHY_EDITOR_VIEW_TYPE } from '../editor/bibliography-editor-view';
import { SourceEditorView } from '../editor/source-editor-view';
import { TypstEditorView, TYPST_EDITOR_VIEW_TYPE } from '../editor/typst-editor-view';
import { requestFormattingEdits } from '../editor/language-features';
import { PreviewController } from '../preview/preview-controller';
import {
	TypstPreviewView,
	TYPST_PREVIEW_VIEW_TYPE,
	shouldRetargetPreview,
	type PreviewThemeOverride,
	type PreviewViewState,
} from '../preview/typst-preview-view';
import { DEFAULT_SETTINGS, migrateSettings, type TypstSettings } from '../settings/settings';
import { TypstError, asTypstError } from '../shared/errors';
import { LogSink, Logger } from '../shared/logging';
import { extensionOf, fileUriToAbsolutePath, absoluteToVaultPath, type VaultPath } from '../shared/paths';
import { resolveDesktopHost, type DesktopHost } from '../platform/desktop';
import { PdfExporter, announceExport } from '../typst/compiler/export';
import { DiagnosticsStore } from '../typst/diagnostics/store';
import { DocumentSession } from '../typst/documents/session';
import { describeProject, resolveProject, vaultFileSystem } from '../typst/project/project';
import type { TinymistClient } from '../typst/tinymist/client';
import { TinymistManager, type TinymistState } from '../typst/tinymist/manager';
import type { InvertColorsStrategy, TinymistInitOptions } from '../typst/tinymist/config';
import {
	TINYMIST_NOTIFICATION,
	type CompileStatusParams,
	type PreviewJumpInfo,
	type PublishDiagnosticsParams,
	type ShowDocumentParams,
} from '../typst/tinymist/protocol';
import { BIBLATEX_EXTENSION, HAYAGRIVA_EXTENSIONS, TYPST_EXTENSION } from './constants';
import { createFile, defaultNewFileFolder, isFolder } from './new-file';
import { StatusBarItem, type CompilePhase } from './status-bar';

/**
 * Where a newly opened preview goes: beside the editor, or in its place.
 *
 * `here` exists for narrow windows, where a split leaves neither pane usable.
 */
export type PreviewLocation = 'split' | 'here';

/**
 * Wires the subsystems together and owns their lifetimes.
 *
 * `main.ts` composes; this coordinates. Every resource acquired here is
 * released in {@link unload}, which is what makes disabling the plugin leave
 * Obsidian exactly as it was found.
 */
export class TypstRuntime {
	private settings: TypstSettings = { ...DEFAULT_SETTINGS };

	private readonly logSink = new LogSink();
	private readonly logger: Logger;
	private readonly diagnostics = new DiagnosticsStore();
	private readonly previews = new PreviewController(new Logger(this.logSink, 'preview'));

	private host: DesktopHost | null = null;
	private session: DocumentSession | null = null;
	private manager: TinymistManager | null = null;
	private exporter: PdfExporter | null = null;
	private statusBar: StatusBarItem | null = null;

	private compilePhase: CompilePhase = 'idle';
	private startupError: TypstError | null = null;
	/** Disposers for notification subscriptions bound to the current client. */
	private clientSubscriptions: (() => void)[] = [];
	/** Extensions this plugin opens, as opposed to ones another plugin got first. */
	private readonly claimedExtensions = new Set<string>();

	constructor(
		private readonly app: App,
		private readonly plugin: Plugin,
	) {
		this.logger = new Logger(this.logSink, 'plugin');
	}

	/* ---------------------------------------------------------------------- */
	/* Lifecycle                                                              */
	/* ---------------------------------------------------------------------- */

	async load(): Promise<void> {
		this.settings = migrateSettings(await this.plugin.loadData());
		this.logSink.setLevel(this.settings.logLevel);

		try {
			this.host = resolveDesktopHost(this.app);
		} catch (error) {
			// Mobile or a non-filesystem vault: the plugin stays inert rather
			// than registering views it cannot serve.
			this.startupError = asTypstError(error, 'platform-unsupported');
			this.logger.error('Tinymist cannot run here', this.startupError.message);
			return;
		}

		this.session = new DocumentSession(this.host.vaultBasePath, this.logger.child('documents'));
		this.exporter = new PdfExporter(this.app.vault, this.logger.child('export'));
		this.manager = this.createManager(this.host);

		this.registerViews();
		this.registerWorkspaceEvents();

		this.diagnostics.onChange((vaultPath) => {
			this.forEachSourceView((view) => {
				if (view.vaultPath === vaultPath) {
					view.refreshDiagnostics();
				}
			});
			this.updateStatusBar();
		});
	}

	/**
	 * Synchronous teardown. Obsidian does not await `onunload`, so anything
	 * that must not outlive the plugin is torn down without awaiting.
	 */
	unload(): void {
		this.disposeClientSubscriptions();
		this.session?.closeAll();
		this.previews.forgetAll();
		this.diagnostics.clearAll();
		// Kills the child process outright; a graceful handshake would not
		// finish before Obsidian tears the plugin down.
		this.manager?.unload();
		this.manager = null;
		this.session = null;
		this.statusBar = null;
	}

	/* ---------------------------------------------------------------------- */
	/* Registration                                                           */
	/* ---------------------------------------------------------------------- */

	attachStatusBar(element: HTMLElement): void {
		this.statusBar = new StatusBarItem(element);
		this.plugin.registerDomEvent(element, 'click', () => {
			void this.onStatusBarClicked();
		});
		this.updateStatusBar();
	}

	private registerViews(): void {
		// What every editor needs to keep Tinymist in step with its buffer.
		const documentSync = {
			getDiagnostics: (vaultPath: VaultPath) =>
				this.settings.showDiagnostics ? this.diagnostics.get(vaultPath) : [],
			onDocumentChanged: (vaultPath: VaultPath, text: string) => {
				this.session?.change(vaultPath, text);
			},
			onDocumentClosed: (vaultPath: VaultPath) => {
				this.session?.close(vaultPath);
				this.diagnostics.clear(vaultPath);
			},
		};

		this.plugin.registerView(
			TYPST_EDITOR_VIEW_TYPE,
			(leaf: WorkspaceLeaf) =>
				new TypstEditorView(leaf, {
					...documentSync,
					logger: this.logger.child('editor'),
					getClient: () => this.manager?.getClient() ?? null,
					getDocumentUri: () => this.activeDocumentUri(),
					onDocumentOpened: (vaultPath, text) => {
						void this.onDocumentOpened(vaultPath, text);
					},
					onCursorMoved: (vaultPath, line, character) => {
						void this.onCursorMoved(vaultPath, line, character);
					},
					onTogglePreviewRequested: (vaultPath) => {
						void this.togglePreview(vaultPath).catch((error: unknown) => {
							this.reportError(error);
						});
					},
					onShowPreviewHereRequested: (vaultPath) => {
						void this.openPreview(vaultPath, 'here').catch((error: unknown) => {
							this.reportError(error);
						});
					},
				}),
		);

		this.plugin.registerView(
			TYPST_PREVIEW_VIEW_TYPE,
			(leaf: WorkspaceLeaf) =>
				new TypstPreviewView(leaf, {
					logger: this.logger.child('preview'),
					resolvePreviewUrl: (vaultPath, themeOverride) =>
						this.resolvePreviewUrl(vaultPath, themeOverride),
					releasePreview: (vaultPath, requester) => {
						this.releasePreview(vaultPath, requester);
					},
					previewStartsPinned: () => !this.settings.previewFollowsActiveDocument,
					openSource: (vaultPath) => this.openSource(vaultPath),
				}),
		);

		this.plugin.registerView(
			BIBLIOGRAPHY_EDITOR_VIEW_TYPE,
			(leaf: WorkspaceLeaf) =>
				new BibliographyEditorView(leaf, {
					...documentSync,
					logger: this.logger.child('bibliography'),
					// Registered, but without starting the server: a bibliography
					// on its own gives Tinymist nothing to compile. The session
					// replays it once a document that cites it starts one.
					onDocumentOpened: (vaultPath, text) => {
						this.session?.open(vaultPath, text);
					},
				}),
		);

		// Obsidian's own PDF view keeps `.pdf`, so an exported PDF opens exactly
		// like any other PDF in the vault.
		this.plugin.registerExtensions([TYPST_EXTENSION], TYPST_EDITOR_VIEW_TYPE);
		this.claimedExtensions.add(TYPST_EXTENSION);
		this.claimExtension(BIBLATEX_EXTENSION, BIBLIOGRAPHY_EDITOR_VIEW_TYPE);
		if (this.settings.openHayagrivaFiles) {
			this.claimHayagrivaFiles();
		}
	}

	/** Claims each YAML extension on its own, so losing one keeps the other. */
	private claimHayagrivaFiles(): void {
		for (const extension of HAYAGRIVA_EXTENSIONS) {
			if (!this.ownsExtension(extension)) {
				this.claimExtension(extension, BIBLIOGRAPHY_EDITOR_VIEW_TYPE);
			}
		}
	}

	/**
	 * Claims an extension that another plugin may already have.
	 *
	 * `.typ` is this plugin's reason to exist and is claimed unguarded. A
	 * bibliography is not: a citation plugin may already open `.bib` files, and
	 * Obsidian throws on a second claim, which would otherwise abort loading the
	 * whole plugin over a secondary feature.
	 */
	private claimExtension(extension: string, viewType: string): void {
		try {
			this.plugin.registerExtensions([extension], viewType);
			this.claimedExtensions.add(extension);
		} catch (error) {
			this.logger.warn(
				`Another plugin already opens .${extension} files; leaving them to it`,
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	/** True when files with this extension open in one of this plugin's editors. */
	ownsExtension(extension: string): boolean {
		return this.claimedExtensions.has(extension);
	}

	private registerWorkspaceEvents(): void {
		this.plugin.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				this.updateStatusBar();
				this.syncFollowingPreviews();
			}),
		);

		// `active-leaf-change` covers switching tabs; `file-open` covers the
		// same tab being pointed at another file, which does not change leaf.
		this.plugin.registerEvent(
			this.app.workspace.on('file-open', () => {
				this.syncFollowingPreviews();
			}),
		);

		// Obsidian's "New note" only ever makes Markdown, and its dropdown is
		// not extensible, so this is the supported way to offer a Typst file
		// where a user looks for one: the folder's context menu.
		this.plugin.registerEvent(
			this.app.workspace.on('file-menu', (menu, target) => {
				if (!isFolder(target)) {
					return;
				}
				menu.addItem((item) => {
					item
						.setTitle('New Typst file')
						.setIcon('file-type')
						// The same section Obsidian puts its own "New note" and
						// "New folder" entries in, so this lands beside them
						// rather than at the bottom of the menu.
						.setSection('action-primary')
						.onClick(() => {
							void this.createFileIn(target);
						});
				});
				if (this.ownsExtension(BIBLATEX_EXTENSION)) {
					menu.addItem((item) => {
						item
							.setTitle('New BibLaTeX file')
							.setIcon('book-marked')
							.setSection('action-primary')
							.onClick(() => {
								void this.createFileIn(target, BIBLATEX_EXTENSION);
							});
					});
				}
				const hayagriva = HAYAGRIVA_EXTENSIONS[0];
				if (this.ownsExtension(hayagriva)) {
					menu.addItem((item) => {
						item
							.setTitle('New Hayagriva file')
							.setIcon('book-marked')
							.setSection('action-primary')
							.onClick(() => {
								void this.createFileIn(target, hayagriva);
							});
					});
				}
			}),
		);

		this.plugin.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile && this.ownsExtension(extensionOf(file.path))) {
					this.session?.rename(oldPath, file.path);
				}
			}),
		);

		this.plugin.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile) {
					this.session?.close(file.path);
					this.diagnostics.clear(file.path);
				}
			}),
		);
	}

	private createManager(host: DesktopHost): TinymistManager {
		return new TinymistManager({
			host,
			logger: this.logger.child('tinymist'),
			getInitOptions: (): TinymistInitOptions => ({
				executablePath: this.settings.tinymistPath,
				projectRootStrategy: this.settings.projectRootStrategy,
				customProjectRoot: this.settings.customProjectRoot,
				vaultBasePath: host.vaultBasePath,
				formatterEnabled: this.settings.formatterEnabled,
				logLevel: this.settings.logLevel,
				systemFonts: this.settings.systemFonts,
				fontPaths: [],
				exportStagingDirectory: this.stagingDirectory,
			}),
			onClientReady: (client) => this.bindClient(client),
			onClientGone: () => {
				this.disposeClientSubscriptions();
				this.session?.detach();
				this.previews.forgetAll();
			},
		});
	}

	/**
	 * Where Tinymist stages exported files before the plugin writes them into
	 * the vault. Inside the plugin's own config folder, so nothing lands in the
	 * user's notes and nothing is written outside the vault.
	 */
	private get stagingDirectory(): string {
		const host = this.host;
		if (!host) {
			return '';
		}
		return `${host.vaultBasePath.replace(/\/+$/, '')}/${this.app.vault.configDir}/plugins/tinymist/.staging`;
	}

	private bindClient(client: TinymistClient): void {
		this.disposeClientSubscriptions();

		this.clientSubscriptions.push(
			client.onNotification('textDocument/publishDiagnostics', (params) => {
				this.onDiagnostics(params as PublishDiagnosticsParams);
			}),
			client.onNotification(TINYMIST_NOTIFICATION.compileStatus, (params) => {
				this.onCompileStatus(params as CompileStatusParams);
			}),
			client.onNotification(TINYMIST_NOTIFICATION.previewScrollSource, (params) => {
				void this.onPreviewScrollSource(params as PreviewJumpInfo);
			}),
			client.onNotification(TINYMIST_NOTIFICATION.previewDispose, (params) => {
				const taskId = (params as { taskId?: string } | undefined)?.taskId;
				if (taskId) {
					this.previews.forgetTask(taskId);
				}
			}),
		);

		this.session?.attach(client);
		this.updateStatusBar();
	}

	private disposeClientSubscriptions(): void {
		for (const dispose of this.clientSubscriptions) {
			dispose();
		}
		this.clientSubscriptions = [];
	}

	/* ---------------------------------------------------------------------- */
	/* Notification handling                                                  */
	/* ---------------------------------------------------------------------- */

	private onDiagnostics(params: PublishDiagnosticsParams): void {
		const vaultPath = this.vaultPathForUri(params.uri);
		if (vaultPath === null) {
			// A document outside the vault, e.g. a Typst package source that an
			// import pulled in. Not ours to report on.
			return;
		}
		this.diagnostics.set(vaultPath, params.diagnostics);
	}

	private onCompileStatus(params: CompileStatusParams): void {
		switch (params.status) {
			case 'compiling':
				this.compilePhase = 'compiling';
				break;
			case 'compileSuccess':
				this.compilePhase = 'success';
				break;
			case 'compileError':
				this.compilePhase = 'error';
				break;
		}
		this.updateStatusBar();
	}

	/** Preview to source: Tinymist asks us to reveal a location. */
	private async onPreviewScrollSource(jump: PreviewJumpInfo): Promise<void> {
		if (!jump.start) {
			return;
		}
		const [line, character] = jump.start;
		await this.revealSource(jump.filepath, line, character);
	}

	/**
	 * Answers `window/showDocument`. Tinymist uses it for the same
	 * preview-to-source jump when the custom notification is not enabled.
	 */
	private async handleShowDocument(params: ShowDocumentParams): Promise<{ success: boolean }> {
		// `external: true` asks for a browser. The plugin does not open
		// external URLs, so it declines rather than pretending it worked.
		if (params.external) {
			return { success: false };
		}

		const absolute = fileUriToAbsolutePath(params.uri);
		if (absolute === null) {
			return { success: false };
		}

		const start = params.selection?.start;
		const revealed = await this.revealSource(absolute, start?.line ?? 0, start?.character ?? 0);
		return { success: revealed };
	}

	/**
	 * Puts the cursor at a source location, opening the document first if it is
	 * not already on screen. Shared by both preview-to-source paths.
	 */
	private async revealSource(
		absolutePath: string,
		line: number,
		character: number,
	): Promise<boolean> {
		if (!this.settings.previewSyncEnabled) {
			return false;
		}

		const host = this.host;
		if (!host) {
			return false;
		}

		// A location outside the vault is not ours to open. Tinymist can report
		// one when a document imports from a Typst package.
		const vaultPath = absoluteToVaultPath(host.vaultBasePath, absolutePath);
		if (vaultPath === null) {
			this.logger.debug('Ignoring a source jump outside the vault');
			return false;
		}

		const open = this.findEditorFor(vaultPath);
		if (open) {
			open.revealPosition(line, character);
			return true;
		}

		await this.openSource(vaultPath);
		const opened = this.findEditorFor(vaultPath);
		opened?.revealPosition(line, character);
		return opened !== null;
	}

	/** Source to preview: the caret moved, so nudge the rendered page. */
	private async onCursorMoved(
		vaultPath: VaultPath,
		line: number,
		character: number,
	): Promise<void> {
		if (!this.settings.previewSyncEnabled) {
			return;
		}
		const client = this.manager?.getClient();
		const session = this.session;
		if (!client || !session || !this.previews.getSession(vaultPath)) {
			return;
		}
		await this.previews.scrollToSource(
			client,
			vaultPath,
			session.absolutePathFor(vaultPath),
			line,
			character,
		);
	}

	private async onDocumentOpened(vaultPath: VaultPath, text: string): Promise<void> {
		const session = this.session;
		if (!session) {
			return;
		}

		// Register the buffer first so nothing is lost if the server is slow.
		session.open(vaultPath, text);
		this.updateStatusBar();

		try {
			await this.ensureServer();
		} catch (error) {
			this.reportError(error);
		}
	}

	/* ---------------------------------------------------------------------- */
	/* Operations used by commands                                            */
	/* ---------------------------------------------------------------------- */

	async ensureServer(): Promise<TinymistClient> {
		if (this.startupError) {
			throw this.startupError;
		}
		const manager = this.manager;
		if (!manager) {
			throw new TypstError('tinymist-not-configured', 'The plugin is not initialized.');
		}
		return await manager.ensureStarted();
	}

	async restartServer(): Promise<void> {
		try {
			await this.manager?.restart();
			new Notice('Tinymist restarted');
		} catch (error) {
			this.reportError(error);
		}
	}

	/**
	 * Opens (or focuses) the preview for a document.
	 *
	 * A preview that is already open wins over the requested location: one
	 * Tinymist task serves one document, and a second frame on the same server
	 * would show the same page twice for no gain.
	 */
	async openPreview(vaultPath: VaultPath, location: PreviewLocation = 'split'): Promise<void> {
		const existing = this.findPreviewFor(vaultPath);
		if (existing) {
			await this.app.workspace.revealLeaf(existing.leaf);
			return;
		}

		const leaf =
			location === 'here' ? this.app.workspace.getLeaf(false) : this.previewSplitLeaf();
		await leaf.setViewState({
			type: TYPST_PREVIEW_VIEW_TYPE,
			active: true,
			state: { vaultPath },
		});
		await this.app.workspace.revealLeaf(leaf);
	}

	/**
	 * A leaf to split a preview into, reusing an idle one before making a new
	 * one so previewing several documents does not pile up tabs.
	 */
	private previewSplitLeaf(): WorkspaceLeaf {
		const idle = this.app.workspace
			.getLeavesOfType(TYPST_PREVIEW_VIEW_TYPE)
			.find((leaf) => leaf.view instanceof TypstPreviewView && !leaf.view.getPreviewedPath());
		return idle ?? this.app.workspace.getLeaf('split', 'vertical');
	}

	/**
	 * Re-points every unpinned preview at the document being edited.
	 *
	 * Reads each leaf's stored state rather than its view: Obsidian defers the
	 * views of leaves that are not visible, so a background preview has no view
	 * object to ask and would otherwise come back showing a document the reader
	 * left long ago.
	 */
	private syncFollowingPreviews(): void {
		const activePath = this.activeEditor()?.vaultPath;
		if (!activePath) {
			// The focus is on a preview, a Markdown note, or nothing at all.
			// None of those mean "stop showing what I was just editing".
			return;
		}

		const pinnedByDefault = !this.settings.previewFollowsActiveDocument;
		for (const leaf of this.app.workspace.getLeavesOfType(TYPST_PREVIEW_VIEW_TYPE)) {
			const current = leaf.getViewState();
			const state = current.state as PreviewViewState | undefined;
			if (!shouldRetargetPreview(state, activePath, pinnedByDefault)) {
				continue;
			}

			void leaf
				.setViewState({
					...current,
					// The resolved pin is written back, so the leaf stops
					// depending on a setting the user may change later.
					state: { ...state, vaultPath: activePath, pinned: false },
				})
				.catch((error: unknown) => {
					this.logger.debug('Re-pointing a preview failed', error);
				});
		}
	}

	/**
	 * Stops a document's preview task unless another preview still shows it.
	 *
	 * Tasks are keyed by document and leaves are not: a pinned preview and a
	 * following one can land on the same file, and whichever leaves first must
	 * not take the other's server with it.
	 *
	 * Read from stored state, for the same reason {@link syncFollowingPreviews}
	 * does: a deferred leaf has no view to ask, and treating it as "not showing
	 * this document" would kill the server it is about to want back. The
	 * requester is excluded by leaf rather than by path, because its own stored
	 * state may still name the document it is in the middle of leaving.
	 */
	private releasePreview(vaultPath: VaultPath, requester: TypstPreviewView): void {
		const stillShown = this.app.workspace
			.getLeavesOfType(TYPST_PREVIEW_VIEW_TYPE)
			.some(
				(leaf) =>
					leaf !== requester.leaf &&
					(leaf.getViewState().state as PreviewViewState | undefined)?.vaultPath ===
						vaultPath,
			);
		if (stillShown) {
			return;
		}
		void this.previews.stop(this.manager?.getClient() ?? null, vaultPath);
	}

	async togglePreview(vaultPath: VaultPath): Promise<void> {
		const existing = this.findPreviewFor(vaultPath);
		if (existing) {
			existing.leaf.detach();
			return;
		}
		await this.openPreview(vaultPath);
	}

	private async resolvePreviewUrl(
		vaultPath: VaultPath,
		themeOverride: PreviewThemeOverride,
	): Promise<string> {
		const client = await this.ensureServer();
		const session = this.session;
		if (!session) {
			throw new TypstError('preview-unavailable', 'The plugin is not initialized.');
		}

		// The document has to be known to the server before it can be previewed,
		// otherwise unsaved text would not be reflected.
		if (!session.isOpen(vaultPath)) {
			const file = this.app.vault.getAbstractFileByPath(vaultPath);
			if (file instanceof TFile) {
				session.open(vaultPath, await this.app.vault.cachedRead(file));
			}
		}

		const preview = await this.previews.start(
			client,
			vaultPath,
			session.absolutePathFor(vaultPath),
			{
				refreshOnType: this.settings.previewRefresh === 'onType',
				partialRendering: this.settings.previewPartialRendering,
				invertColors: this.resolveInvertColors(themeOverride),
			},
		);
		return preview.url;
	}

	/**
	 * Turns a per-preview override, or the setting when there is none, into the
	 * strategy Tinymist takes. A dark page is produced by inverting, which is
	 * why "dark" maps to `always`.
	 */
	private resolveInvertColors(themeOverride: PreviewThemeOverride): InvertColorsStrategy {
		const theme = themeOverride ?? this.settings.previewTheme;
		switch (theme) {
			case 'light':
				return 'never';
			case 'dark':
				return 'always';
			case 'follow-obsidian':
			default:
				return this.isDarkMode() ? 'always' : 'never';
		}
	}

	async exportPdf(vaultPath: VaultPath): Promise<void> {
		const exporter = this.exporter;
		const session = this.session;
		if (!exporter || !session) {
			return;
		}

		try {
			const client = await this.ensureServer();
			const notice = new Notice('Exporting PDF…', 0);
			try {
				const outcome = await exporter.export(
					client,
					{
						sourceVaultPath: vaultPath,
						sourceAbsolutePath: session.absolutePathFor(vaultPath),
					},
					{
						exportFolder: this.settings.exportFolder,
						overwrite: this.settings.exportOverwrite,
					},
				);
				announceExport(outcome);
			} finally {
				notice.hide();
			}
		} catch (error) {
			this.reportError(error);
		}
	}

	async formatDocument(view: TypstEditorView): Promise<void> {
		const vaultPath = view.vaultPath;
		const session = this.session;
		if (!vaultPath || !session) {
			return;
		}
		if (!this.settings.formatterEnabled) {
			new Notice('The typst formatter is turned off in settings');
			return;
		}

		try {
			const client = await this.ensureServer();

			// The edits' positions describe the document as it is now, so a
			// keystroke arriving while the request is in flight would make them
			// land in the wrong place. Snapshotting is cheaper than trying to
			// rebase them, and formatting is quick enough that a user rarely
			// notices the refusal.
			const before = view.getViewData();
			const edits = await requestFormattingEdits(client, session.uriFor(vaultPath));

			if (edits.length === 0) {
				new Notice('Nothing to reformat');
				return;
			}

			if (view.getViewData() !== before) {
				new Notice('Document changed while formatting; nothing was applied');
				return;
			}

			if (!view.applyTextEdits(edits)) {
				new Notice('The formatter returned edits that could not be applied');
			}
		} catch (error) {
			this.reportError(error);
		}
	}

	/** Reveals the source document for a preview, reusing an open tab. */
	async openSource(vaultPath: VaultPath): Promise<void> {
		const file = this.app.vault.getFileByPath(vaultPath);
		if (!file) {
			new Notice('That typst document is no longer in the vault');
			return;
		}

		const open = this.findEditorFor(vaultPath);
		if (open) {
			await this.app.workspace.revealLeaf(open.leaf);
			open.focusEditor();
			return;
		}

		await this.app.workspace.getLeaf(false).openFile(file);
	}

	/** Creates an empty file in a folder and opens it. */
	async createFileIn(folder: TFolder, extension: string = TYPST_EXTENSION): Promise<void> {
		try {
			await createFile(this.app, folder, extension);
		} catch (error) {
			this.reportError(error);
		}
	}

	/**
	 * Creates a file where Obsidian would put a new note, honouring the user's
	 * "Default location for new notes" setting.
	 */
	async createFileInDefaultFolder(extension: string = TYPST_EXTENSION): Promise<void> {
		await this.createFileIn(defaultNewFileFolder(this.app), extension);
	}

	/** Describes the project a document belongs to, for the command palette. */
	describeProjectFor(vaultPath: VaultPath): string {
		const project = resolveProject(vaultFileSystem(this.app.vault), vaultPath, {
			strategy: this.settings.projectRootStrategy,
			customRoot: this.settings.customProjectRoot,
		});
		return describeProject(project);
	}

	/* ---------------------------------------------------------------------- */
	/* Settings                                                               */
	/* ---------------------------------------------------------------------- */

	getSettings(): TypstSettings {
		return this.settings;
	}

	async updateSettings(patch: Partial<TypstSettings>): Promise<void> {
		const restartKeys: (keyof TypstSettings)[] = [
			'tinymistPath',
			'projectRootStrategy',
			'customProjectRoot',
			'systemFonts',
			'formatterEnabled',
		];
		const needsRestart = restartKeys.some(
			(key) => key in patch && patch[key] !== this.settings[key],
		);

		// Normalized rather than merged raw. The settings framework hands values
		// back as `unknown`, so running the result through the same validation
		// that guards `loadData` keeps `data.json` valid no matter who wrote to
		// it, instead of leaving a bad value to be corrected on next load.
		this.settings = migrateSettings({ ...this.settings, ...patch });
		await this.plugin.saveData(this.settings);
		this.logSink.setLevel(this.settings.logLevel);

		if ('showDiagnostics' in patch) {
			this.forEachSourceView((view) => view.refreshDiagnostics());
		}

		// Claiming takes effect at once. Obsidian has no public way to hand an
		// extension back, so turning this off waits for the next start, which
		// the setting's description says. `session` is set only once the views
		// are registered, i.e. on a platform the plugin can serve at all.
		if (this.settings.openHayagrivaFiles && this.session) {
			this.claimHayagrivaFiles();
		}

		// Tinymist reads most of this at initialize time, so a restart is the
		// honest way to apply it rather than pretending it took effect.
		if (needsRestart && this.manager?.getState().kind === 'ready') {
			await this.manager.restart();
		}
	}

	describeServerState(): string {
		const state: TinymistState | undefined = this.manager?.getState();
		if (this.startupError) {
			return this.startupError.headline;
		}
		switch (state?.kind) {
			case 'ready':
				return 'Running';
			case 'starting':
				return 'Starting';
			case 'crashed':
				return 'Stopped unexpectedly';
			case 'failed':
				return state.error.headline;
			default:
				return 'Not running';
		}
	}

	getDetectedVersion(): string | null {
		return this.manager?.getVersion()?.raw ?? null;
	}

	getDetectedTypstVersion(): string | null {
		return this.manager?.getTypstVersion() ?? null;
	}

	describeExecutable(): string {
		const state = this.manager?.getState();
		if (state?.kind === 'ready') {
			return `${state.executable.path} (${state.executable.source === 'path' ? 'found on PATH' : 'configured'})`;
		}
		return this.settings.tinymistPath || 'not resolved yet';
	}

	/* ---------------------------------------------------------------------- */
	/* Helpers                                                                */
	/* ---------------------------------------------------------------------- */

	/** The active Typst editor, or `null` when the focus is elsewhere. */
	activeEditor(): TypstEditorView | null {
		const view = this.app.workspace.getActiveViewOfType(TypstEditorView);
		return view ?? null;
	}

	private activeDocumentUri(): string | null {
		const vaultPath = this.activeEditor()?.vaultPath;
		if (!vaultPath || !this.session) {
			return null;
		}
		return this.session.uriFor(vaultPath);
	}

	private vaultPathForUri(uri: string): VaultPath | null {
		const host = this.host;
		if (!host) {
			return null;
		}
		const absolute = fileUriToAbsolutePath(uri);
		return absolute === null ? null : absoluteToVaultPath(host.vaultBasePath, absolute);
	}

	private findEditorFor(vaultPath: VaultPath): TypstEditorView | null {
		for (const leaf of this.app.workspace.getLeavesOfType(TYPST_EDITOR_VIEW_TYPE)) {
			// Deferred views mean `leaf.view` is not necessarily our class yet.
			if (leaf.view instanceof TypstEditorView && leaf.view.vaultPath === vaultPath) {
				return leaf.view;
			}
		}
		return null;
	}

	private findPreviewFor(vaultPath: VaultPath): TypstPreviewView | null {
		for (const leaf of this.app.workspace.getLeavesOfType(TYPST_PREVIEW_VIEW_TYPE)) {
			if (leaf.view instanceof TypstPreviewView && leaf.view.getPreviewedPath() === vaultPath) {
				return leaf.view;
			}
		}
		return null;
	}

	/** Every open editor Tinymist is kept in step with, bibliographies included. */
	private forEachSourceView(callback: (view: SourceEditorView) => void): void {
		for (const viewType of [TYPST_EDITOR_VIEW_TYPE, BIBLIOGRAPHY_EDITOR_VIEW_TYPE]) {
			for (const leaf of this.app.workspace.getLeavesOfType(viewType)) {
				if (leaf.view instanceof SourceEditorView) {
					callback(leaf.view);
				}
			}
		}
	}

	private isDarkMode(): boolean {
		// `activeDocument` so the theme is read from the window the user is
		// actually looking at, which may be a popout.
		return activeDocument.body.hasClass('theme-dark');
	}

	private updateStatusBar(): void {
		const active = this.activeEditor();
		const vaultPath = active?.vaultPath ?? null;

		this.statusBar?.update({
			serverState: this.startupError ? 'failed' : (this.manager?.getState().kind ?? 'stopped'),
			compilePhase: this.compilePhase,
			diagnostics: vaultPath
				? this.diagnostics.summarize(vaultPath)
				: { errors: 0, warnings: 0, total: 0 },
			hasActiveDocument: vaultPath !== null,
		});
	}

	private async onStatusBarClicked(): Promise<void> {
		const state = this.manager?.getState();
		if (state?.kind === 'crashed') {
			await this.restartServer();
			return;
		}
		if (state?.kind === 'failed' || this.startupError) {
			const error = this.startupError ?? (state?.kind === 'failed' ? state.error : null);
			if (error) {
				new Notice(error.toUserMessage(), 10_000);
			}
		}
	}

	/** Turns any failure into one actionable notice plus a log entry. */
	reportError(error: unknown): void {
		const typstError = asTypstError(error, 'lsp-request-failed');
		this.logger.error(typstError.headline, typstError.message);
		new Notice(typstError.toUserMessage(), 10_000);
	}
}
