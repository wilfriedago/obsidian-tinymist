import { describe, expect, it } from 'vitest';

import {
	MINIMUM_TINYMIST_VERSION,
	compareVersions,
	formatVersion,
	parseTypstVersionFromBanner,
	parseVersionOutput,
	satisfiesMinimum,
} from '../../src/typst/tinymist/version';

describe('parseVersionOutput', () => {
	it('parses the short form printed by `tinymist -V`', () => {
		expect(parseVersionOutput('tinymist 0.15.8\n')).toMatchObject({
			major: 0,
			minor: 15,
			patch: 8,
			raw: '0.15.8',
		});
	});

	it('returns null for the empty version some builds print', () => {
		// The Homebrew 0.15.8 bottle prints a bare `tinymist ` as the first line
		// of `--version`. Treating that as 0.0.0 would wrongly fail the minimum
		// check, so it has to be distinguishable from a real version.
		expect(parseVersionOutput('tinymist \n')).toBeNull();
		expect(parseVersionOutput('')).toBeNull();
	});

	it('ignores the surrounding build banner', () => {
		const banner = [
			'tinymist 0.15.8',
			'Build Timestamp:     2026-09-08T09:55:16.000000000Z',
			'Typst Version:       0.15.1',
		].join('\n');
		expect(parseVersionOutput(banner)?.raw).toBe('0.15.8');
	});

	it('accepts a v prefix and a prerelease suffix', () => {
		expect(parseVersionOutput('tinymist v1.2.3')?.raw).toBe('1.2.3');
		expect(parseVersionOutput('tinymist 1.2.3-rc.1')?.raw).toBe('1.2.3');
	});

	it('rejects output from a different program', () => {
		expect(parseVersionOutput('typst 0.15.1')).toBeNull();
	});
});

describe('parseTypstVersionFromBanner', () => {
	it('reads the bundled Typst version', () => {
		expect(parseTypstVersionFromBanner('Typst Version:       0.15.1\n')).toBe('0.15.1');
	});

	it('returns null when the banner has no such line', () => {
		expect(parseTypstVersionFromBanner('tinymist 0.15.8')).toBeNull();
	});
});

describe('version comparison', () => {
	const v = (major: number, minor: number, patch: number) => ({
		major,
		minor,
		patch,
		raw: `${major}.${minor}.${patch}`,
	});

	it('orders by major, then minor, then patch', () => {
		expect(compareVersions(v(1, 0, 0), v(0, 99, 99))).toBeGreaterThan(0);
		expect(compareVersions(v(0, 15, 8), v(0, 15, 9))).toBeLessThan(0);
		expect(compareVersions(v(0, 15, 8), v(0, 15, 8))).toBe(0);
	});

	it('checks the minimum this plugin was written against', () => {
		expect(satisfiesMinimum(v(0, 15, 8))).toBe(true);
		expect(satisfiesMinimum(MINIMUM_TINYMIST_VERSION)).toBe(true);
		expect(satisfiesMinimum(v(0, 12, 0))).toBe(false);
	});

	it('formats an unknown version readably', () => {
		expect(formatVersion(null)).toBe('unknown');
		expect(formatVersion(v(0, 15, 8))).toBe('0.15.8');
	});
});
