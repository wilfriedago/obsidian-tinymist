import { describe, expect, it } from 'vitest';

import { buildSearchPath } from '../../src/platform/desktop';

/**
 * A desktop app launched from Finder or the Dock does not inherit the shell's
 * environment. On macOS it gets this, and nothing else — which is why a
 * `tinymist` that `which` finds instantly is invisible to Obsidian.
 */
const MACOS_GUI_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

describe('buildSearchPath', () => {
	it('adds the Homebrew directory a GUI launch is missing', () => {
		const result = buildSearchPath({ PATH: MACOS_GUI_PATH, HOME: '/Users/me' }, 'darwin');
		expect(result.split(':')).toContain('/opt/homebrew/bin');
		expect(result.split(':')).toContain('/usr/local/bin');
	});

	it('appends rather than prepends, so the user\'s own PATH still wins', () => {
		const result = buildSearchPath({ PATH: '/my/own/bin', HOME: '/Users/me' }, 'darwin');
		expect(result.split(':')[0]).toBe('/my/own/bin');
	});

	it('expands $HOME for per-user install locations', () => {
		const result = buildSearchPath({ PATH: '/usr/bin', HOME: '/Users/me' }, 'darwin');
		expect(result.split(':')).toContain('/Users/me/.cargo/bin');
		expect(result.split(':')).toContain('/Users/me/.local/bin');
	});

	it('skips a directory whose variable is unset rather than emitting a literal $HOME', () => {
		const result = buildSearchPath({ PATH: '/usr/bin' }, 'darwin');
		expect(result).not.toContain('$HOME');
		expect(result.split(':')).toContain('/opt/homebrew/bin');
	});

	it('never duplicates a directory already present', () => {
		const result = buildSearchPath(
			{ PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/Users/me' },
			'darwin',
		);
		const occurrences = result.split(':').filter((dir) => dir === '/opt/homebrew/bin');
		expect(occurrences).toHaveLength(1);
	});

	it('uses Windows separators and locations on Windows', () => {
		const result = buildSearchPath(
			{
				Path: 'C:\\Windows\\system32',
				USERPROFILE: 'C:\\Users\\me',
				LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
			},
			'win32',
		);
		const dirs = result.split(';');
		expect(dirs[0]).toBe('C:\\Windows\\system32');
		expect(dirs).toContain('C:\\Users\\me\\scoop\\shims');
		expect(dirs).toContain('C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links');
		expect(dirs).toContain('C:\\Users\\me\\.cargo\\bin');
	});

	it('does not add Unix locations on Windows, or Windows ones on Unix', () => {
		const windows = buildSearchPath({ Path: 'C:\\Windows', USERPROFILE: 'C:\\U' }, 'win32');
		expect(windows).not.toContain('/opt/homebrew/bin');

		const unix = buildSearchPath({ PATH: '/usr/bin', HOME: '/h' }, 'darwin');
		expect(unix).not.toContain('scoop');
	});

	it('copes with an empty or absent PATH', () => {
		expect(buildSearchPath({}, 'darwin').split(':')).toContain('/opt/homebrew/bin');
		expect(buildSearchPath({ PATH: '' }, 'darwin').split(':')).toContain('/opt/homebrew/bin');
		expect(buildSearchPath({ PATH: '' }, 'darwin').startsWith(':')).toBe(false);
	});

	it('includes the Linux package-manager locations on Linux', () => {
		const result = buildSearchPath({ PATH: '/usr/bin', HOME: '/home/me' }, 'linux');
		expect(result.split(':')).toContain('/snap/bin');
		expect(result.split(':')).toContain('/home/linuxbrew/.linuxbrew/bin');
	});
});
