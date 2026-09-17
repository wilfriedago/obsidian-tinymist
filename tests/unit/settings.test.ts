import { describe, expect, it } from 'vitest';

import {
	DEFAULT_SETTINGS,
	SETTINGS_VERSION,
	isSettingKey,
	migrateSettings,
} from '../../src/settings/settings';

describe('migrateSettings', () => {
	it('returns the defaults for a first run', () => {
		expect(migrateSettings(undefined)).toEqual(DEFAULT_SETTINGS);
		expect(migrateSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(migrateSettings({})).toEqual(DEFAULT_SETTINGS);
	});

	it('keeps values it recognizes', () => {
		const migrated = migrateSettings({
			tinymistPath: '/opt/tinymist',
			logLevel: 'debug',
			projectRootStrategy: 'vault',
			previewRefresh: 'onSave',
			exportOverwrite: true,
		});
		expect(migrated.tinymistPath).toBe('/opt/tinymist');
		expect(migrated.logLevel).toBe('debug');
		expect(migrated.projectRootStrategy).toBe('vault');
		expect(migrated.previewRefresh).toBe('onSave');
		expect(migrated.exportOverwrite).toBe(true);
	});

	it('replaces values of the wrong type rather than passing them through', () => {
		// `data.json` is an ordinary file in the vault, so a bad value there
		// must not reach Tinymist's configuration.
		const migrated = migrateSettings({
			tinymistPath: 42,
			showDiagnostics: 'yes',
			previewSyncEnabled: null,
			exportFolder: ['a'],
		});
		expect(migrated.tinymistPath).toBe(DEFAULT_SETTINGS.tinymistPath);
		expect(migrated.showDiagnostics).toBe(DEFAULT_SETTINGS.showDiagnostics);
		expect(migrated.previewSyncEnabled).toBe(DEFAULT_SETTINGS.previewSyncEnabled);
		expect(migrated.exportFolder).toBe(DEFAULT_SETTINGS.exportFolder);
	});

	it('rejects values outside the allowed set', () => {
		const migrated = migrateSettings({
			logLevel: 'verbose',
			projectRootStrategy: 'magic',
			previewTheme: 'neon',
		});
		expect(migrated.logLevel).toBe(DEFAULT_SETTINGS.logLevel);
		expect(migrated.projectRootStrategy).toBe(DEFAULT_SETTINGS.projectRootStrategy);
		expect(migrated.previewTheme).toBe(DEFAULT_SETTINGS.previewTheme);
	});

	it('drops unknown keys and stamps the current schema version', () => {
		const migrated = migrateSettings({ version: 0, somethingRemoved: true });
		expect(migrated.version).toBe(SETTINGS_VERSION);
		expect(migrated).not.toHaveProperty('somethingRemoved');
	});

	it('survives a non-object payload', () => {
		expect(migrateSettings('corrupt')).toEqual(DEFAULT_SETTINGS);
		expect(migrateSettings(7)).toEqual(DEFAULT_SETTINGS);
	});
});

describe('isSettingKey', () => {
	it('accepts every key the plugin actually has', () => {
		for (const key of Object.keys(DEFAULT_SETTINGS)) {
			expect(isSettingKey(key), key).toBe(true);
		}
	});

	it('rejects anything else', () => {
		// Obsidian's declarative settings API calls setControlValue with a
		// plain string, so this guard is what stops an unknown key being
		// written into data.json.
		expect(isSettingKey('notASetting')).toBe(false);
		expect(isSettingKey('')).toBe(false);
	});

	it('is not fooled by inherited object properties', () => {
		expect(isSettingKey('toString')).toBe(false);
		expect(isSettingKey('constructor')).toBe(false);
		expect(isSettingKey('__proto__')).toBe(false);
	});
});

describe('normalizing a write', () => {
	it('keeps a bad value from reaching storage', () => {
		// The settings framework hands values back as `unknown`; running the
		// merged result through migrateSettings is what guarantees data.json
		// stays valid whatever a caller passes.
		const merged = migrateSettings({
			...DEFAULT_SETTINGS,
			previewRefresh: 'whenever',
			showDiagnostics: 'yes',
		});
		expect(merged.previewRefresh).toBe(DEFAULT_SETTINGS.previewRefresh);
		expect(merged.showDiagnostics).toBe(DEFAULT_SETTINGS.showDiagnostics);
	});

	it('preserves values that are valid', () => {
		const merged = migrateSettings({ ...DEFAULT_SETTINGS, previewTheme: 'dark' });
		expect(merged.previewTheme).toBe('dark');
	});
});
