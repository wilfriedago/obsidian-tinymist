/**
 * Detecting and comparing the version of the Tinymist executable the user has
 * installed.
 *
 * Note on which flag to use: `tinymist --version` prints a multi-line build
 * banner whose first line omits the version entirely on some builds (the
 * Homebrew 0.15.8 bottle prints a bare `tinymist `). `tinymist -V` prints the
 * short form `tinymist 0.15.8` reliably. We parse `-V` and treat `--version`
 * only as a source of supplementary build details.
 */

export interface TinymistVersion {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
	/** The version as printed, e.g. `0.15.8`. */
	readonly raw: string;
}

/**
 * The oldest Tinymist this plugin is written against. Below this we cannot rely
 * on the preview command surface (`tinymist.doStartPreview` and friends) or on
 * the export argument shape.
 */
export const MINIMUM_TINYMIST_VERSION: TinymistVersion = Object.freeze({
	major: 0,
	minor: 13,
	patch: 0,
	raw: '0.13.0',
});

const SHORT_VERSION = /^\s*tinymist\s+v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?\s*$/;

/**
 * Parses the output of `tinymist -V`. Returns `null` when the output does not
 * carry a version, which is how we detect the empty-version builds rather than
 * silently treating them as `0.0.0`.
 */
export function parseVersionOutput(output: string): TinymistVersion | null {
	for (const line of output.split(/\r?\n/)) {
		const match = SHORT_VERSION.exec(line);
		if (!match) {
			continue;
		}
		const [, major, minor, patch] = match;
		return {
			major: Number(major),
			minor: Number(minor),
			patch: Number(patch),
			raw: `${major}.${minor}.${patch}`,
		};
	}
	return null;
}

/** Extracts `Typst Version: 0.15.1` from the `--version` banner, if present. */
export function parseTypstVersionFromBanner(output: string): string | null {
	const match = /^\s*Typst Version:\s*(\S+)\s*$/m.exec(output);
	return match?.[1] ?? null;
}

/** Negative when `a < b`, zero when equal, positive when `a > b`. */
export function compareVersions(a: TinymistVersion, b: TinymistVersion): number {
	return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** True when `version` is at least `minimum`. */
export function satisfiesMinimum(
	version: TinymistVersion,
	minimum: TinymistVersion = MINIMUM_TINYMIST_VERSION,
): boolean {
	return compareVersions(version, minimum) >= 0;
}

export function formatVersion(version: TinymistVersion | null): string {
	return version?.raw ?? 'unknown';
}
