import { describe, expect, it } from 'vitest';

import {
	buildInitializationOptions,
	buildPreviewArgs,
	resolveExecutable,
	resolveWorkspaceRoot,
	type TinymistInitOptions,
} from '../../src/typst/tinymist/config';
import { classifySpawnError } from '../../src/platform/desktop';

const baseOptions: TinymistInitOptions = {
	executablePath: '',
	projectRootStrategy: 'auto',
	customProjectRoot: '',
	vaultBasePath: '/home/me/vault',
	formatterEnabled: true,
	logLevel: 'warn',
	systemFonts: true,
	fontPaths: [],
	exportStagingDirectory: '/tmp/staging',
};

describe('resolveWorkspaceRoot', () => {
	it('sends no root under the automatic strategy', () => {
		// This is the whole point of `auto`: Tinymist checks workspace roots
		// before it looks for a typst.toml, so sending the vault as the root
		// would make every typst.toml in the vault inert.
		expect(resolveWorkspaceRoot(baseOptions)).toBeNull();
	});

	it('sends the vault base under the vault strategy', () => {
		expect(resolveWorkspaceRoot({ ...baseOptions, projectRootStrategy: 'vault' })).toBe(
			'/home/me/vault',
		);
	});

	it('joins a custom root onto the vault base', () => {
		expect(
			resolveWorkspaceRoot({
				...baseOptions,
				projectRootStrategy: 'custom',
				customProjectRoot: '/papers/thesis/',
			}),
		).toBe('/home/me/vault/papers/thesis');
	});

	it('falls back to the vault when the custom root is blank', () => {
		expect(
			resolveWorkspaceRoot({
				...baseOptions,
				projectRootStrategy: 'custom',
				customProjectRoot: '   ',
			}),
		).toBe('/home/me/vault');
	});
});

describe('buildInitializationOptions', () => {
	it('never asks Tinymist to export on its own', () => {
		expect(buildInitializationOptions(baseOptions)['exportPdf']).toBe('never');
	});

	it('stages exports outside the vault', () => {
		expect(buildInitializationOptions(baseOptions)['outputPath']).toBe('/tmp/staging/$name');
	});

	it('omits rootPath entirely under the automatic strategy', () => {
		expect(buildInitializationOptions(baseOptions)).not.toHaveProperty('rootPath');
	});

	it('includes rootPath when a root is chosen', () => {
		const config = buildInitializationOptions({
			...baseOptions,
			projectRootStrategy: 'vault',
		});
		expect(config['rootPath']).toBe('/home/me/vault');
	});

	it('turns the formatter off when the setting is off', () => {
		expect(
			buildInitializationOptions({ ...baseOptions, formatterEnabled: false })['formatterMode'],
		).toBe('disable');
	});

	it('omits fontPaths unless some are configured', () => {
		expect(buildInitializationOptions(baseOptions)).not.toHaveProperty('fontPaths');
		expect(
			buildInitializationOptions({ ...baseOptions, fontPaths: ['/fonts'] })['fontPaths'],
		).toEqual(['/fonts']);
	});
});

describe('buildPreviewArgs', () => {
	const args = (overrides = {}) =>
		buildPreviewArgs({
			taskId: 'obsidian-abc',
			entryAbsolutePath: '/home/me/vault/a b/main.typ',
			notPrimary: false,
			invertColors: 'never',
			refreshOnType: true,
			...overrides,
		});

	it('uses the kebab-case refresh values the CLI accepts', () => {
		// `onType` is rejected by tinymist 0.15.8 with
		// "invalid value 'onType' for '--refresh-style'".
		expect(args()).toContain('on-type');
		expect(args({ refreshOnType: false })).toContain('on-save');
		expect(args().join(' ')).not.toContain('onType');
	});

	it('binds to loopback on an ephemeral port', () => {
		const flat = args().join(' ');
		expect(flat).toContain('--data-plane-host 127.0.0.1:0');
		expect(flat).toContain('--host 127.0.0.1:0');
	});

	it('never opens a browser', () => {
		expect(args()).toContain('--no-open');
	});

	it('passes the entry last and unquoted, so spaces survive', () => {
		const built = args();
		expect(built[built.length - 1]).toBe('/home/me/vault/a b/main.typ');
	});

	it('marks a secondary preview as not primary', () => {
		expect(args({ notPrimary: true })).toContain('--not-primary');
		expect(args({ notPrimary: false })).not.toContain('--not-primary');
	});

	it('passes the invert-colors choice through', () => {
		expect(args({ invertColors: 'auto' }).join(' ')).toContain('--invert-colors auto');
	});
});

describe('resolveExecutable', () => {
	it('uses an explicit configured path', () => {
		expect(resolveExecutable('/opt/tinymist')).toEqual({
			path: '/opt/tinymist',
			source: 'configured',
		});
	});

	it('trims surrounding whitespace', () => {
		expect(resolveExecutable('  /opt/tinymist  ').path).toBe('/opt/tinymist');
	});

	it('falls back to the bare command name, which the OS resolves via PATH', () => {
		// The plugin imports no filesystem module, so it does not walk PATH
		// itself: `spawn` does that natively for a bare name.
		expect(resolveExecutable('')).toEqual({ path: 'tinymist', source: 'path' });
		expect(resolveExecutable('   ')).toEqual({ path: 'tinymist', source: 'path' });
	});
});

describe('classifySpawnError', () => {
	it('recognizes a missing executable', () => {
		expect(classifySpawnError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(
			'not-found',
		);
	});

	it('recognizes a permission problem', () => {
		expect(classifySpawnError(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe(
			'not-executable',
		);
		expect(classifySpawnError(Object.assign(new Error('x'), { code: 'EPERM' }))).toBe(
			'not-executable',
		);
	});

	it('falls back to unknown for anything else', () => {
		expect(classifySpawnError(new Error('boom'))).toBe('unknown');
		expect(classifySpawnError(undefined)).toBe('unknown');
	});
});
