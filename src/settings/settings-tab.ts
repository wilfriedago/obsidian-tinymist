import { PluginSettingTab, Setting, type App, type Plugin } from 'obsidian';

import { LOG_LEVELS } from '../shared/logging';
import type { TypstSettings } from './settings';

/**
 * The settings screen.
 *
 * Kept to the choices a user actually has to make. Tinymist exposes dozens of
 * knobs; surfacing them all here would turn a document editor into a compiler
 * console, so the plugin picks sensible defaults and exposes the rest only
 * where a real workflow needs it.
 *
 * Copy follows Obsidian's style guide: sentence case, no "settings" in headings,
 * and no top-level heading naming the plugin.
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
	private statusEl: HTMLElement | null = null;

	constructor(
		app: App,
		plugin: Plugin,
		private readonly host: SettingsTabHost,
	) {
		super(app, plugin);
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderStatus(containerEl);
		this.renderTinymist(containerEl);
		this.renderProject(containerEl);
		this.renderPreview(containerEl);
		this.renderEditor(containerEl);
		this.renderExport(containerEl);
		this.renderAdvanced(containerEl);
	}

	private renderStatus(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('Language server')
			.setDesc(this.statusText())
			.addButton((button) =>
				button
					.setButtonText('Restart')
					.setCta()
					.onClick(async () => {
						button.setDisabled(true);
						button.setButtonText('Restarting…');
						try {
							await this.host.restartServer();
						} finally {
							this.display();
						}
					}),
			);

		this.statusEl = containerEl.createDiv({ cls: 'tinymist-settings-status' });
		this.statusEl.textContent = `Executable: ${this.host.describeExecutable()}`;
	}

	private statusText(): string {
		const version = this.host.getDetectedVersion();
		const typst = this.host.getDetectedTypstVersion();
		const parts = [this.host.describeServerState()];
		if (version) {
			parts.push(`Tinymist ${version}`);
		}
		if (typst) {
			parts.push(`Typst ${typst}`);
		}
		return parts.join(' · ');
	}

	private renderTinymist(containerEl: HTMLElement): void {
		const settings = this.host.getSettings();

		new Setting(containerEl)
			.setName('Tinymist executable')
			.setDesc(
				'Absolute path to the Tinymist binary. Leave empty to use the first "tinymist" found on PATH. This plugin never downloads or updates it for you.',
			)
			.addText((text) =>
				text
					.setPlaceholder('/opt/homebrew/bin/tinymist')
					.setValue(settings.tinymistPath)
					.onChange(async (value) => {
						await this.host.updateSettings({ tinymistPath: value.trim() });
					}),
			);
	}

	private renderProject(containerEl: HTMLElement): void {
		const settings = this.host.getSettings();

		new Setting(containerEl).setName('Project').setHeading();

		new Setting(containerEl)
			.setName('Project root')
			.setDesc(
				'How the compilation root is chosen for a document. "Automatic" uses the nearest folder containing a typst.toml, and otherwise the document\'s own folder.',
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption('auto', 'Automatic')
					.addOption('vault', 'Always the vault root')
					.addOption('custom', 'A folder I choose')
					.setValue(settings.projectRootStrategy)
					.onChange(async (value) => {
						await this.host.updateSettings({
							projectRootStrategy: value as TypstSettings['projectRootStrategy'],
						});
						this.display();
					}),
			);

		if (settings.projectRootStrategy === 'custom') {
			new Setting(containerEl)
				.setName('Project folder')
				.setDesc('Vault-relative folder used as the compilation root for every document.')
				.addText((text) =>
					text
						.setPlaceholder('papers/thesis')
						.setValue(settings.customProjectRoot)
						.onChange(async (value) => {
							await this.host.updateSettings({ customProjectRoot: value.trim() });
						}),
				);
		}
	}

	private renderPreview(containerEl: HTMLElement): void {
		const settings = this.host.getSettings();

		new Setting(containerEl).setName('Preview').setHeading();

		new Setting(containerEl)
			.setName('Refresh')
			.setDesc('When the preview recompiles.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('onType', 'As you type')
					.addOption('onSave', 'On save')
					.setValue(settings.previewRefresh)
					.onChange(async (value) => {
						await this.host.updateSettings({
							previewRefresh: value as TypstSettings['previewRefresh'],
						});
					}),
			);

		new Setting(containerEl)
			.setName('Theme')
			.setDesc(
				"Default colours for the rendered page. Each preview can override this from its own toolbar.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption('follow-obsidian', 'Follow the app')
					.addOption('light', 'Light')
					.addOption('dark', 'Dark')
					.setValue(settings.previewTheme)
					.onChange(async (value) => {
						await this.host.updateSettings({
							previewTheme: value as TypstSettings['previewTheme'],
						});
					}),
			);

		new Setting(containerEl)
			.setName('Sync with the editor')
			.setDesc(
				'Scroll the preview to the cursor, and move the cursor when you select rendered content.',
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.previewSyncEnabled).onChange(async (value) => {
					await this.host.updateSettings({ previewSyncEnabled: value });
				}),
			);
	}

	private renderEditor(containerEl: HTMLElement): void {
		const settings = this.host.getSettings();

		new Setting(containerEl).setName('Editor').setHeading();

		new Setting(containerEl)
			.setName('Show diagnostics')
			.setDesc('Underline compiler errors and warnings while you edit.')
			.addToggle((toggle) =>
				toggle.setValue(settings.showDiagnostics).onChange(async (value) => {
					await this.host.updateSettings({ showDiagnostics: value });
				}),
			);

		new Setting(containerEl)
			.setName('Enable the formatter')
			.setDesc('Allow the "Format document" command to reformat Typst source.')
			.addToggle((toggle) =>
				toggle.setValue(settings.formatterEnabled).onChange(async (value) => {
					await this.host.updateSettings({ formatterEnabled: value });
				}),
			);
	}

	private renderExport(containerEl: HTMLElement): void {
		const settings = this.host.getSettings();

		new Setting(containerEl).setName('Export').setHeading();

		new Setting(containerEl)
			.setName('PDF folder')
			.setDesc(
				'Vault-relative folder for exported PDFs. Leave empty to write the PDF beside its source document.',
			)
			.addText((text) =>
				text
					.setPlaceholder('Beside the document')
					.setValue(settings.exportFolder)
					.onChange(async (value) => {
						await this.host.updateSettings({ exportFolder: value.trim() });
					}),
			);

		new Setting(containerEl)
			.setName('Replace existing PDFs')
			.setDesc(
				'When off, exporting writes a numbered copy instead of overwriting a PDF that is already there.',
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.exportOverwrite).onChange(async (value) => {
					await this.host.updateSettings({ exportOverwrite: value });
				}),
			);
	}

	private renderAdvanced(containerEl: HTMLElement): void {
		const settings = this.host.getSettings();

		new Setting(containerEl).setName('Advanced').setHeading();

		new Setting(containerEl)
			.setName('Use system fonts')
			.setDesc('Let Typst use the fonts installed on this computer.')
			.addToggle((toggle) =>
				toggle.setValue(settings.systemFonts).onChange(async (value) => {
					await this.host.updateSettings({ systemFonts: value });
				}),
			);

		new Setting(containerEl)
			.setName('Logging')
			.setDesc('How much the plugin writes to the developer console.')
			.addDropdown((dropdown) => {
				for (const level of LOG_LEVELS) {
					dropdown.addOption(level, level === 'silent' ? 'Off' : capitalize(level));
				}
				dropdown.setValue(settings.logLevel).onChange(async (value) => {
					await this.host.updateSettings({ logLevel: value as TypstSettings['logLevel'] });
				});
			});
	}
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}
