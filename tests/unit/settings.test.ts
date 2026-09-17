import { describe, expect, it } from 'vitest';

import {
	DEFAULT_SETTINGS,
	SETTINGS_VERSION,
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
