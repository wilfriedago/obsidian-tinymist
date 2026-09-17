/**
 * Path and URI conversions between the three namespaces this plugin straddles:
 *
 *   vault path      `papers/thesis/main.typ`      — what Obsidian's APIs take
 *   absolute path   `/Users/x/vault/papers/...`   — what Tinymist takes
 *   file URI        `file:///Users/x/vault/...`   — what LSP messages carry
 *
 * Every function here is pure: the vault's base directory is always passed in.
 * That keeps the conversions unit-testable without a live vault, and keeps the
 * Windows/POSIX split explicit rather than implicit in `node:path` behaviour.
 */

/** Documents are identified by vault-relative path, never by basename. */
export type VaultPath = string;

const WINDOWS_DRIVE = /^[a-zA-Z]:$/;

/** True when the absolute path looks like a Windows path (`C:\...` or `C:/...`). */
export function isWindowsAbsolutePath(absolutePath: string): boolean {
	return /^[a-zA-Z]:[\\/]/.test(absolutePath);
}

/**
 * Collapses separators and resolves `.`/`..` segments without touching the
 * filesystem. Keeps a leading `/` or a `C:` drive prefix.
 */
export function normalizeAbsolutePath(absolutePath: string): string {
	const windows = isWindowsAbsolutePath(absolutePath);
	const unified = absolutePath.replace(/\\/g, '/');

	const firstSlash = unified.indexOf('/');
	const prefix = windows ? unified.slice(0, firstSlash) : '';
	const body = windows ? unified.slice(firstSlash) : unified;

	const segments: string[] = [];
	for (const segment of body.split('/')) {
		if (segment === '' || segment === '.') {
			continue;
		}
		if (segment === '..') {
			segments.pop();
			continue;
		}
		segments.push(segment);
	}

	return `${prefix}/${segments.join('/')}`.replace(/\/$/, prefix ? '/' : '') || '/';
}

/**
 * Joins a vault-relative path onto the vault's base directory.
 * The vault path is normalized first, so `..` cannot escape the vault.
 */
export function vaultPathToAbsolute(vaultBasePath: string, vaultPath: VaultPath): string {
	const contained = containVaultPath(vaultPath);
	const base = normalizeAbsolutePath(vaultBasePath);
	const separator = base.endsWith('/') ? '' : '/';
	return contained === '' ? base : normalizeAbsolutePath(`${base}${separator}${contained}`);
}

/**
 * Resolves a vault path to its segments, dropping any segment that would climb
 * above the vault root. A caller cannot use `../../etc/passwd` to escape.
 */
export function containVaultPath(vaultPath: VaultPath): string {
	const segments: string[] = [];
	for (const segment of vaultPath.replace(/\\/g, '/').split('/')) {
		if (segment === '' || segment === '.') {
			continue;
		}
		if (segment === '..') {
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	return segments.join('/');
}

/**
 * Converts an absolute path back to a vault-relative path, or `null` when the
 * path lies outside the vault. Callers use the `null` to refuse work on files
 * the plugin has no business touching.
 */
export function absoluteToVaultPath(vaultBasePath: string, absolutePath: string): VaultPath | null {
	const base = normalizeAbsolutePath(vaultBasePath);
	const target = normalizeAbsolutePath(absolutePath);

	const comparableBase = comparablePath(base);
	const comparableTarget = comparablePath(target);

	if (comparableTarget === comparableBase) {
		return '';
	}

	const prefix = comparableBase.endsWith('/') ? comparableBase : `${comparableBase}/`;
	if (!comparableTarget.startsWith(prefix)) {
		return null;
	}

	return target.slice(prefix.length);
}

/**
 * Case-folds on platforms whose filesystems are conventionally case-insensitive.
 * Used only for containment and identity comparisons, never for display.
 */
function comparablePath(path: string): string {
	return isWindowsAbsolutePath(path) ? path.toLowerCase() : path;
}

/** True when `absolutePath` is the vault directory or lives inside it. */
export function isInsideVault(vaultBasePath: string, absolutePath: string): boolean {
	return absoluteToVaultPath(vaultBasePath, absolutePath) !== null;
}

/** Percent-encodes a single path segment for a `file:` URI. */
function encodeSegment(segment: string): string {
	return encodeURIComponent(segment).replace(/%2F/gi, '/');
}

/**
 * Builds the `file:` URI that LSP messages carry. Windows drive letters are
 * upper-cased and prefixed with the extra `/` the scheme requires.
 */
export function absolutePathToFileUri(absolutePath: string): string {
	const normalized = normalizeAbsolutePath(absolutePath);
	const windows = isWindowsAbsolutePath(normalized);

	if (windows) {
		const firstSlash = normalized.indexOf('/');
		const drive = normalized.slice(0, firstSlash).toUpperCase();
		const rest = normalized.slice(firstSlash + 1);
		const encoded = rest.split('/').map(encodeSegment).join('/');
		return `file:///${drive}/${encoded}`;
	}

	const encoded = normalized.slice(1).split('/').map(encodeSegment).join('/');
	return `file:///${encoded}`;
}

/**
 * Inverse of {@link absolutePathToFileUri}. Returns `null` for any URI that is
 * not a local `file:` URI, so remote schemes never reach filesystem code.
 */
export function fileUriToAbsolutePath(uri: string): string | null {
	if (!uri.startsWith('file://')) {
		return null;
	}

	const withoutScheme = uri.slice('file://'.length);
	// A non-empty authority means a UNC or remote host; we do not handle those.
	const pathStart = withoutScheme.indexOf('/');
	if (pathStart !== 0) {
		return null;
	}

	let decoded: string;
	try {
		decoded = decodeURIComponent(withoutScheme);
	} catch {
		return null;
	}

	const candidate = decoded.slice(1);
	const firstSegment = candidate.split('/')[0] ?? '';
	if (WINDOWS_DRIVE.test(firstSegment)) {
		return normalizeAbsolutePath(candidate);
	}

	return normalizeAbsolutePath(decoded);
}

/** Lower-cased extension without the dot, or `''` when there is none. */
export function extensionOf(path: string): string {
	const base = path.slice(path.replace(/\\/g, '/').lastIndexOf('/') + 1);
	const dot = base.lastIndexOf('.');
	return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** Replaces a path's extension, e.g. `main.typ` -> `main.pdf`. */
export function withExtension(path: string, extension: string): string {
	const current = extensionOf(path);
	return current === '' ? `${path}.${extension}` : `${path.slice(0, -current.length)}${extension}`;
}

/** The parent directory of a vault path, or `''` for a top-level file. */
export function parentVaultPath(vaultPath: VaultPath): VaultPath {
	const contained = containVaultPath(vaultPath);
	const slash = contained.lastIndexOf('/');
	return slash === -1 ? '' : contained.slice(0, slash);
}
