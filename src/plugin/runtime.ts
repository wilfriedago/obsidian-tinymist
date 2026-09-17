import { Notice, TFile, type App, type Plugin, type WorkspaceLeaf } from 'obsidian';

import { TypstEditorView, TYPST_EDITOR_VIEW_TYPE } from '../editor/typst-editor-view';
import { requestFormattingEdits } from '../editor/language-features';
import { PreviewController } from '../preview/preview-controller';
import {
	TypstPreviewView,
	TYPST_PREVIEW_VIEW_TYPE,
	type PreviewThemeOverride,
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
} from '../typst/tinymist/protocol';
import { StatusBarItem, type CompilePhase } from './status-bar';

export const TYPST_EXTENSION = 'typ';

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
			this.forEachEditor((view) => {
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
		this.plugin.registerView(
			TYPST_EDITOR_VIEW_TYPE,
			(leaf: WorkspaceLeaf) =>
				new TypstEditorView(leaf, {
					logger: this.logger.child('editor'),
					getClient: () => this.manager?.getClient() ?? null,
					getDocumentUri: () => this.activeDocumentUri(),
					getDiagnostics: (vaultPath) =>
						this.settings.showDiagnostics ? this.diagnostics.get(vaultPath) : [],
					onDocumentOpened: (vaultPath, text) => {
						void this.onDocumentOpened(vaultPath, text);
					},
					onDocumentChanged: (vaultPath, text) => {
						this.session?.change(vaultPath, text);
					},
					onDocumentClosed: (vaultPath) => {
						this.session?.close(vaultPath);
						this.diagnostics.clear(vaultPath);
					},
					onCursorMoved: (vaultPath, line, character) => {
						void this.onCursorMoved(vaultPath, line, character);
					},
					onTogglePreviewRequested: (vaultPath) => {
						void this.togglePreview(vaultPath).catch((error: unknown) => {
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
					releasePreview: (vaultPath) => {
						void this.previews.stop(this.manager?.getClient() ?? null, vaultPath);
					},
					openSource: (vaultPath) => this.openSource(vaultPath),
				}),
		);

		// Claims `.typ` only. Obsidian's own PDF view keeps `.pdf`, so an
		// exported PDF opens exactly like any other PDF in the vault.
		this.plugin.registerExtensions([TYPST_EXTENSION], TYPST_EDITOR_VIEW_TYPE);
	}

	private registerWorkspaceEvents(): void {
		this.plugin.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				this.updateStatusBar();
			}),
		);

		this.plugin.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile && extensionOf(file.path) === TYPST_EXTENSION) {
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
		if (!this.settings.previewSyncEnabled || !jump.start) {
			return;
		}

		const host = this.host;
		if (!host) {
			return;
		}
		const vaultPath = absoluteToVaultPath(host.vaultBasePath, jump.filepath);
		if (vaultPath === null) {
			return;
		}

		const [line, character] = jump.start;
		const open = this.findEditorFor(vaultPath);
		if (open) {
			open.revealPosition(line, character);
			return;
		}

		await this.openSource(vaultPath);
		this.findEditorFor(vaultPath)?.revealPosition(line, character);
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

	/** Opens (or focuses) the preview for a document, beside its editor. */
	async openPreview(vaultPath: VaultPath): Promise<void> {
		const existing = this.findPreviewFor(vaultPath);
		if (existing) {
			await this.app.workspace.revealLeaf(existing.leaf);
			return;
		}

		// Reuse an idle preview leaf before opening a second one, so previewing
		// a different document does not pile up tabs.
		const idle = this.app.workspace
			.getLeavesOfType(TYPST_PREVIEW_VIEW_TYPE)
			.find((leaf) => leaf.view instanceof TypstPreviewView && !leaf.view.getPreviewedPath());

		const leaf = idle ?? this.app.workspace.getLeaf('split', 'vertical');
		await leaf.setViewState({
			type: TYPST_PREVIEW_VIEW_TYPE,
			active: true,
			state: { vaultPath },
		});
		await this.app.workspace.revealLeaf(leaf);
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
			new Notice('The Typst formatter is turned off in settings');
			return;
		}

		try {
			const client = await this.ensureServer();
			const edits = await requestFormattingEdits(client, session.uriFor(vaultPath));
			if (edits.length === 0) {
				new Notice('Nothing to reformat');
				return;
			}
			// Tinymist's formatter returns a single whole-document edit; using
			// its text directly avoids replaying ranges against a buffer that
			// may have changed while the request was in flight.
			const replacement = edits.length === 1 ? edits[0]?.newText : undefined;
			if (replacement !== undefined) {
				view.replaceAll(replacement);
			}
		} catch (error) {
			this.reportError(error);
		}
	}

	/** Reveals the source document for a preview, reusing an open tab. */
	async openSource(vaultPath: VaultPath): Promise<void> {
		const file = this.app.vault.getFileByPath(vaultPath);
		if (!file) {
			new Notice('That Typst document is no longer in the vault');
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

		this.settings = { ...this.settings, ...patch };
		await this.plugin.saveData(this.settings);
		this.logSink.setLevel(this.settings.logLevel);

		if ('showDiagnostics' in patch) {
			this.forEachEditor((view) => view.refreshDiagnostics());
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

	private forEachEditor(callback: (view: TypstEditorView) => void): void {
		for (const leaf of this.app.workspace.getLeavesOfType(TYPST_EDITOR_VIEW_TYPE)) {
			if (leaf.view instanceof TypstEditorView) {
				callback(leaf.view);
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
