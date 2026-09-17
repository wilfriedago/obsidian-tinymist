import type { LogLevel } from '../../shared/logging';

/**
 * Where the Tinymist executable comes from, and what configuration it is
 * started with.
 *
 * The plugin never downloads a binary. Obsidian's developer policies forbid a
 * plugin installing or updating its own dependencies, so the executable is
 * always something the user put on their machine.
 */

export const TINYMIST_EXECUTABLE_NAME = 'tinymist';

/** How the executable in use was arrived at. Surfaced in settings. */
export type ExecutableSource = 'configured' | 'path';

export interface ResolvedExecutable {
	readonly path: string;
	readonly source: ExecutableSource;
}

/**
 * Decides what command to run.
 *
 *   1. An explicit path from the plugin settings, if one is set.
 *   2. Otherwise the bare name `tinymist`, which the operating system resolves
 *      through `PATH` when the process is spawned.
 *
 * Deliberately pure and synchronous. Whether the command actually works is
 * settled by running `tinymist probe` and reading the result, which is both a
 * stronger check than a permission bit — it confirms the program really is
 * Tinymist — and the reason this plugin needs no filesystem access at all.
 *
 * There is deliberately no step that fetches anything.
 */
export function resolveExecutable(configuredPath: string): ResolvedExecutable {
	const configured = configuredPath.trim();
	return configured.length > 0
		? { path: configured, source: 'configured' }
		: { path: TINYMIST_EXECUTABLE_NAME, source: 'path' };
}

/** How the plugin resolves the Typst project root for a document. */
export type ProjectRootStrategy = 'auto' | 'vault' | 'custom';

export interface TinymistInitOptions {
	/** Explicit executable path from settings; empty means "look on PATH". */
	readonly executablePath: string;
	readonly projectRootStrategy: ProjectRootStrategy;
	/** Used only when the strategy is `custom`; a vault-relative folder path. */
	readonly customProjectRoot: string;
	readonly vaultBasePath: string;
	readonly formatterEnabled: boolean;
	readonly logLevel: LogLevel;
	readonly systemFonts: boolean;
	/** Absolute paths to extra font directories. Empty by default. */
	readonly fontPaths: readonly string[];
	/**
	 * Absolute path of a plugin-owned temporary directory. Every Tinymist
	 * export is routed here; the plugin then writes the result into the vault
	 * itself. See {@link buildInitializationOptions} for why.
	 */
	readonly exportStagingDirectory: string;
}

/**
 * The absolute path sent as the LSP workspace root, or `null` to send none.
 *
 * This single decision drives Tinymist's whole project model, because its
 * resolver (`crates/tinymist-project/src/entry.rs`) checks the workspace roots
 * *before* it looks for a `typst.toml`:
 *
 *   rootPath config -> workspace roots -> typst.toml ancestor -> file's parent
 *
 * So declaring the vault as the root would flatten every paper in the vault
 * into one project and make `typst.toml` inert. `auto` therefore sends no root
 * and lets Tinymist do per-file discovery, which is what gives each paper
 * directory its own root.
 */
export function resolveWorkspaceRoot(options: TinymistInitOptions): string | null {
	switch (options.projectRootStrategy) {
		case 'vault':
			return options.vaultBasePath;
		case 'custom': {
			const relative = options.customProjectRoot.trim().replace(/^\/+|\/+$/g, '');
			if (relative.length === 0) {
				return options.vaultBasePath;
			}
			return `${options.vaultBasePath.replace(/\/+$/, '')}/${relative}`;
		}
		case 'auto':
		default:
			return null;
	}
}

/**
 * Builds Tinymist's `initializationOptions`.
 *
 * Keys are Tinymist's own configuration names, verified against
 * `CONFIG_ITEMS` in `crates/tinymist/src/config.rs` at 0.15.8. Anything not
 * listed there is ignored by the server, so we send only known keys.
 */
export function buildInitializationOptions(
	options: TinymistInitOptions,
): Record<string, unknown> {
	const root = resolveWorkspaceRoot(options);

	const config: Record<string, unknown> = {
		// `onSave`/`onType` would make Tinymist write PDFs on its own. Export in
		// this plugin is an explicit user action that writes into the vault, so
		// automatic export stays off.
		exportPdf: 'never',
		// Tinymist always writes the exported file to `outputPath`, even when the
		// export command is invoked with `{ write: false }` (verified against
		// 0.15.8). Pointing it at a plugin-owned temporary directory is what
		// keeps stray PDFs out of the vault: the plugin takes the returned bytes
		// and writes the real file through Obsidian's Vault API, so the
		// destination, the overwrite policy, and the file index all stay ours.
		// `$name` is the entry's basename; the extension comes from the target.
		outputPath: `${options.exportStagingDirectory.replace(/\/+$/, '')}/$name`,
		// Single-file resolution matches how Obsidian treats notes: each file is
		// its own document, and no lock file is written into the user's vault.
		projectResolution: 'singleFile',
		semanticTokens: 'disable',
		systemFonts: options.systemFonts,
		compileStatus: 'enable',
		formatterMode: options.formatterEnabled ? 'typstyle' : 'disable',
		// The plugin renders hovers as plain Markdown in Obsidian's own popover,
		// so the periscope image preview would be wasted work.
		hoverPeriscope: 'disable',
		// Makes preview-to-source jumps arrive as `tinymist/preview/scrollSource`.
		// Without it Tinymist falls back to a `window/showDocument` request
		// (see `EditorScrollTo` in its preview tool), and clicking the preview
		// does nothing unless the client answers that instead. Both paths are
		// handled here, but this is the one the reference client uses.
		customizedShowDocument: true,
	};

	if (root !== null) {
		config['rootPath'] = root;
	}
	if (options.fontPaths.length > 0) {
		config['fontPaths'] = [...options.fontPaths];
	}

	return config;
}

/** The colour-inversion strategies Tinymist's preview accepts. */
export type InvertColorsStrategy = 'never' | 'auto' | 'always';

/** Arguments for `tinymist.doStartPreview`, in the CLI form the command expects. */
export interface PreviewArgsOptions {
	readonly taskId: string;
	/** Absolute path of the entry file. Tinymist rejects relative paths here. */
	readonly entryAbsolutePath: string;
	/** `true` for every preview after the first, per Tinymist's primary-instance model. */
	readonly notPrimary: boolean;
	/**
	 * How Tinymist should invert the rendered page's colours.
	 * `never` is a light page, `always` a dark one, `auto` defers to the
	 * viewer. These are the accepted values, verified against the preview
	 * frontend's own `INVERT_COLORS_STRATEGY`.
	 */
	readonly invertColors: InvertColorsStrategy;
	readonly refreshOnType: boolean;
}

export function buildPreviewArgs(options: PreviewArgsOptions): string[] {
	const args = [
		'--task-id',
		options.taskId,
		// Port 0 lets the OS pick a free port, so two vaults never collide.
		'--data-plane-host',
		'127.0.0.1:0',
		'--host',
		'127.0.0.1:0',
		'--invert-colors',
		options.invertColors,
		// Kebab-case: the CLI enum renames these, and `onType` is rejected.
		// Verified against tinymist 0.15.8.
		'--refresh-style',
		options.refreshOnType ? 'on-type' : 'on-save',
		// The preview is shown inside Obsidian; opening a browser too would be
		// a surprise, and the flag defaults to on for the CLI.
		'--no-open',
	];

	if (options.notPrimary) {
		args.push('--not-primary');
	}

	args.push(options.entryAbsolutePath);
	return args;
}
