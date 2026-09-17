import {
	PluginSettingTab,
	type App,
	type Plugin,
	type SettingDefinitionItem,
} from 'obsidian';

import { LOG_LEVELS } from '../shared/logging';
import { isSettingKey, type TypstSettings } from './settings';

/**
 * The settings screen, defined declaratively.
 *
 * Obsidian 1.13 renders, persists, validates, and — importantly — *indexes for
 * search* a tab described through `getSettingDefinitions()`. The older
 * imperative `display()` is deprecated, and a tab that still uses it is absent
 * from the settings search users rely on to find anything.
 *
 * Settings live in the plugin's runtime rather than on `plugin.settings`, so
 * `getControlValue`/`setControlValue` are overridden to point at it. That is
 * what those hooks exist for, and it keeps the runtime the single owner of
 * settings state and of the side effects a change triggers.
 *
 * Copy follows Obsidian's style guide: sentence case, no "settings" in
 * headings, and no top-level heading naming the plugin.
 */

export interface SettingsTabHost {
	getSettings(): TypstSettings;
	updateSettings(patch: Partial<TypstSettings>): Promise<void>;
	/** Restarts Tinymist and resolves once it is ready or has failed. */
	restartServer(): Promise<void>;
	/** Human-readable server state for the status line. */
	describeServerState(): string;
	/** Detected Tinymist version, or `null` when it is not running. */
	getDetectedVersion(): string | null;
	getDetectedTypstVersion(): string | null;
	/** Where the executable was found, for the status line. */
	describeExecutable(): string;
}

export class TypstSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		plugin: Plugin,
		private readonly host: SettingsTabHost,
	) {
		super(app, plugin);
	}

	/**
	 * Reads from the runtime instead of `this.plugin.settings`.
	 *
	 * The framework passes a plain `string`, so the key is narrowed rather than
	 * asserted: an unknown one reads as `undefined` and the control falls back
	 * to its `defaultValue`.
	 */
	override getControlValue(key: string): unknown {
		return isSettingKey(key) ? this.host.getSettings()[key] : undefined;
	}

	/** Writes through the runtime, so a change still triggers its side effects. */
	override async setControlValue(key: string, value: unknown): Promise<void> {
		if (!isSettingKey(key)) {
			// Nothing this plugin owns; refuse rather than write an unknown key
			// into `data.json`.
			return;
		}

		await this.host.updateSettings({ [key]: value });
		// Several settings change what other rows should show or say.
		this.update();
	}

	override getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			...this.serverDefinitions(),
			this.projectGroup(),
			this.previewGroup(),
			this.editorGroup(),
			this.exportGroup(),
			this.advancedGroup(),
		];
	}

	/* ---------------------------------------------------------------------- */
	/* Groups                                                                 */
	/* ---------------------------------------------------------------------- */

	/** General settings sit at the top with no heading, per the style guide. */
	private serverDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'Tinymist executable',
				desc: 'Absolute path to the Tinymist binary. Leave empty to use the first "tinymist" found on PATH. This plugin never downloads or updates it for you.',
				aliases: ['path', 'binary', 'executable', 'language server'],
				control: {
					type: 'text',
					key: 'tinymistPath',
					placeholder: '/opt/homebrew/bin/tinymist',
				},
			},
			{
				name: 'Language server',
				desc: this.statusText(),
				aliases: ['restart', 'reload', 'version'],
				action: (_el, _index) => {
					void this.host.restartServer().finally(() => {
						this.update();
					});
				},
			},
		];
	}

	private projectGroup(): SettingDefinitionItem {
		const isCustom = this.host.getSettings().projectRootStrategy === 'custom';

		return {
			type: 'group',
			heading: 'Project',
			items: [
				{
					name: 'Project root',
					desc: 'How the compilation root is chosen for a document. "Automatic" uses the nearest folder containing a typst.toml, and otherwise the document\'s own folder.',
					aliases: ['typst.toml', 'workspace', 'root'],
					control: {
						type: 'dropdown',
						key: 'projectRootStrategy',
						options: {
							auto: 'Automatic',
							vault: 'Always the vault root',
							custom: 'A folder I choose',
						},
					},
				},
				{
					name: 'Project folder',
					desc: 'Vault-relative folder used as the compilation root for every document.',
					// Only meaningful under the custom strategy, and hidden from
					// search when it cannot apply.
					visible: () => this.host.getSettings().projectRootStrategy === 'custom',
					searchable: isCustom,
					control: {
						type: 'folder',
						key: 'customProjectRoot',
						placeholder: 'papers/thesis',
					},
				},
			],
		};
	}

	private previewGroup(): SettingDefinitionItem {
		return {
			type: 'group',
			heading: 'Preview',
			items: [
				{
					name: 'Refresh',
					desc: 'When the preview recompiles.',
					control: {
						type: 'dropdown',
						key: 'previewRefresh',
						options: { onType: 'As you type', onSave: 'On save' },
					},
				},
				{
					name: 'Theme',
					desc: 'Default colours for the rendered page. Each preview can override this from its own toolbar.',
					aliases: ['dark', 'light', 'invert'],
					control: {
						type: 'dropdown',
						key: 'previewTheme',
						options: {
							'follow-obsidian': 'Follow the app',
							light: 'Light',
							dark: 'Dark',
						},
					},
				},
				{
					name: 'Sync with the editor',
					desc: 'Scroll the preview to the cursor, and move the cursor when you select rendered content.',
					aliases: ['scroll', 'jump', 'navigate'],
					control: { type: 'toggle', key: 'previewSyncEnabled' },
				},
			],
		};
	}

	private editorGroup(): SettingDefinitionItem {
		return {
			type: 'group',
			heading: 'Editor',
			items: [
				{
					name: 'Show diagnostics',
					desc: 'Underline compiler errors and warnings while you edit.',
					aliases: ['errors', 'warnings', 'lint'],
					control: { type: 'toggle', key: 'showDiagnostics' },
				},
				{
					name: 'Enable the formatter',
					desc: 'Allow the "Format document" command to reformat Typst source.',
					aliases: ['format', 'typstyle'],
					control: { type: 'toggle', key: 'formatterEnabled' },
				},
			],
		};
	}

	private exportGroup(): SettingDefinitionItem {
		return {
			type: 'group',
			heading: 'Export',
			items: [
				{
					name: 'PDF folder',
					desc: 'Vault-relative folder for exported PDFs. Leave empty to write the PDF beside its source document.',
					aliases: ['pdf', 'output', 'destination'],
					control: {
						type: 'folder',
						key: 'exportFolder',
						placeholder: 'Beside the document',
					},
				},
				{
					name: 'Replace existing PDFs',
					desc: 'When off, exporting writes a numbered copy instead of overwriting a PDF that is already there.',
					aliases: ['overwrite', 'clobber'],
					control: { type: 'toggle', key: 'exportOverwrite' },
				},
			],
		};
	}

	private advancedGroup(): SettingDefinitionItem {
		return {
			type: 'group',
			heading: 'Advanced',
			items: [
				{
					name: 'Use system fonts',
					desc: 'Let Typst use the fonts installed on this computer.',
					aliases: ['fonts', 'typeface'],
					control: { type: 'toggle', key: 'systemFonts' },
				},
				{
					name: 'Logging',
					desc: 'How much the plugin writes to the developer console.',
					aliases: ['debug', 'verbose', 'console'],
					control: {
						type: 'dropdown',
						key: 'logLevel',
						options: Object.fromEntries(
							LOG_LEVELS.map((level) => [
								level,
								level === 'silent' ? 'Off' : capitalize(level),
							]),
						),
					},
				},
			],
		};
	}

	/** The server's state and detected versions, shown under the restart row. */
	private statusText(): string {
		const parts = [this.host.describeServerState()];

		const version = this.host.getDetectedVersion();
		if (version) {
			parts.push(`Tinymist ${version}`);
		}

		const typst = this.host.getDetectedTypstVersion();
		if (typst) {
			parts.push(`Typst ${typst}`);
		}

		parts.push(this.host.describeExecutable());
		return parts.join(' · ');
	}
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}
