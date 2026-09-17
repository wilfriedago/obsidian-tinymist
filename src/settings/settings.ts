import { isLogLevel, type LogLevel } from '../shared/logging';
import type { ProjectRootStrategy } from '../typst/tinymist/config';

/**
 * Persisted plugin settings, their defaults, and migration from older shapes.
 *
 * `version` is the settings-schema version, not the plugin version. It only
 * changes when a stored field changes meaning, so migrations stay rare and
 * explicit.
 */

export const SETTINGS_VERSION = 1;

export type PreviewRefreshMode = 'onType' | 'onSave';
export type PreviewTheme = 'follow-obsidian' | 'light' | 'dark';

export interface TypstSettings {
	readonly version: number;

	/** Absolute path to the Tinymist executable. Empty means "find on PATH". */
	tinymistPath: string;
	logLevel: LogLevel;

	projectRootStrategy: ProjectRootStrategy;
	/** Vault-relative folder used when the strategy is `custom`. */
	customProjectRoot: string;

	previewRefresh: PreviewRefreshMode;
	previewTheme: PreviewTheme;
	/** Move the preview when the cursor moves, and the cursor when the preview is clicked. */
	previewSyncEnabled: boolean;

	showDiagnostics: boolean;
	formatterEnabled: boolean;
	systemFonts: boolean;

	/** Vault-relative folder for exported PDFs. Empty means "beside the source". */
	exportFolder: string;
	/** Overwrite an existing PDF instead of writing `name-1.pdf`. */
	exportOverwrite: boolean;
}

export const DEFAULT_SETTINGS: TypstSettings = {
	version: SETTINGS_VERSION,
	tinymistPath: '',
	logLevel: 'warn',
	projectRootStrategy: 'auto',
	customProjectRoot: '',
	previewRefresh: 'onType',
	previewTheme: 'follow-obsidian',
	previewSyncEnabled: true,
	showDiagnostics: true,
	formatterEnabled: true,
	systemFonts: true,
	exportFolder: '',
	exportOverwrite: false,
};

const PROJECT_ROOT_STRATEGIES: readonly ProjectRootStrategy[] = ['auto', 'vault', 'custom'];
const PREVIEW_REFRESH_MODES: readonly PreviewRefreshMode[] = ['onType', 'onSave'];
const PREVIEW_THEMES: readonly PreviewTheme[] = ['follow-obsidian', 'light', 'dark'];

/**
 * Turns whatever `loadData()` returned into valid settings.
 *
 * Every field is validated rather than trusted: `data.json` is a file in the
 * user's vault that other tools can touch, and a bad value there should not be
 * able to send a malformed configuration to Tinymist.
 */
export function migrateSettings(raw: unknown): TypstSettings {
	const stored = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

	return {
		version: SETTINGS_VERSION,
		tinymistPath: asString(stored['tinymistPath'], DEFAULT_SETTINGS.tinymistPath),
		logLevel: asLogLevel(stored['logLevel'], DEFAULT_SETTINGS.logLevel),
		projectRootStrategy: asEnum(
			stored['projectRootStrategy'],
			PROJECT_ROOT_STRATEGIES,
			DEFAULT_SETTINGS.projectRootStrategy,
		),
		customProjectRoot: asString(stored['customProjectRoot'], DEFAULT_SETTINGS.customProjectRoot),
		previewRefresh: asEnum(
			stored['previewRefresh'],
			PREVIEW_REFRESH_MODES,
			DEFAULT_SETTINGS.previewRefresh,
		),
		previewTheme: asEnum(stored['previewTheme'], PREVIEW_THEMES, DEFAULT_SETTINGS.previewTheme),
		previewSyncEnabled: asBoolean(
			stored['previewSyncEnabled'],
			DEFAULT_SETTINGS.previewSyncEnabled,
		),
		showDiagnostics: asBoolean(stored['showDiagnostics'], DEFAULT_SETTINGS.showDiagnostics),
		formatterEnabled: asBoolean(stored['formatterEnabled'], DEFAULT_SETTINGS.formatterEnabled),
		systemFonts: asBoolean(stored['systemFonts'], DEFAULT_SETTINGS.systemFonts),
		exportFolder: asString(stored['exportFolder'], DEFAULT_SETTINGS.exportFolder),
		exportOverwrite: asBoolean(stored['exportOverwrite'], DEFAULT_SETTINGS.exportOverwrite),
	};
}

/**
 * Narrows a key handed back by Obsidian's settings framework to one this
 * plugin actually has.
 *
 * The declarative settings API calls `getControlValue`/`setControlValue` with
 * a plain `string`, so without this an unrecognized key would be written
 * straight into `data.json`. Derived from `DEFAULT_SETTINGS`, so it cannot
 * drift out of step with the interface.
 */
export function isSettingKey(key: string): key is keyof TypstSettings {
	return Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key);
}

function asString(value: unknown, fallback: string): string {
	return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

function asLogLevel(value: unknown, fallback: LogLevel): LogLevel {
	return isLogLevel(value) ? value : fallback;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === 'string' && (allowed as readonly string[]).includes(value)
		? (value as T)
		: fallback;
}
