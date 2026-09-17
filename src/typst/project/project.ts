import type { Vault } from 'obsidian';

import { parentVaultPath, type VaultPath } from '../../shared/paths';
import type { ProjectRootStrategy } from '../tinymist/config';

/**
 * Working out which directory a `.typ` file belongs to.
 *
 * Tinymist is the authority here: its resolver decides what the compiler sees,
 * and this module deliberately mirrors that algorithm rather than inventing a
 * parallel one. What it adds is the vault-relative answer, for the status bar,
 * the settings screen, and the export destination — places where the plugin has
 * to tell the user which project a file is in.
 *
 * Tinymist's order (`crates/tinymist-project/src/entry.rs`, 0.15.8):
 *
 *   1. the `rootPath` configuration entry
 *   2. the first LSP workspace root containing the file
 *   3. the nearest ancestor holding a `typst.toml`
 *   4. the file's own parent directory
 *
 * Step 2 outranking step 3 is the reason the plugin's `auto` strategy sends no
 * workspace root at all: declaring the vault as the root would make every
 * `typst.toml` in the vault inert and collapse every paper into one project.
 */

export const TYPST_MANIFEST_NAME = 'typst.toml';

export type ProjectRootOrigin =
	| 'configured'
	| 'vault'
	| 'manifest'
	| 'parent-directory';

export interface TypstProject {
	/** Vault-relative folder path. `''` is the vault root. */
	readonly root: VaultPath;
	readonly origin: ProjectRootOrigin;
	/** Vault-relative path of the `typst.toml` that decided it, when one did. */
	readonly manifestPath: VaultPath | null;
}

export interface ProjectResolutionOptions {
	readonly strategy: ProjectRootStrategy;
	/** Vault-relative folder used when the strategy is `custom`. */
	readonly customRoot: string;
}

/** Just enough of `Vault` to resolve a project, so tests need no real vault. */
export interface ProjectFileSystem {
	exists(vaultPath: VaultPath): boolean;
}

export function vaultFileSystem(vault: Vault): ProjectFileSystem {
	return {
		exists: (vaultPath) => vault.getAbstractFileByPath(vaultPath) !== null,
	};
}

/**
 * Resolves the project a document belongs to.
 *
 * Deterministic and filesystem-light: it walks from the file's directory up to
 * the vault root, checking for a manifest at each step, and never looks outside
 * the vault.
 */
export function resolveProject(
	fs: ProjectFileSystem,
	documentVaultPath: VaultPath,
	options: ProjectResolutionOptions,
): TypstProject {
	if (options.strategy === 'custom') {
		const configured = trimSlashes(options.customRoot);
		return { root: configured, origin: 'configured', manifestPath: null };
	}

	if (options.strategy === 'vault') {
		return { root: '', origin: 'vault', manifestPath: null };
	}

	// `auto`: mirror Tinymist's manifest walk, then fall back to the parent.
	const startDirectory = parentVaultPath(documentVaultPath);
	for (const directory of ancestorsInclusive(startDirectory)) {
		const manifestPath = directory.length > 0 ? `${directory}/${TYPST_MANIFEST_NAME}` : TYPST_MANIFEST_NAME;
		if (fs.exists(manifestPath)) {
			return { root: directory, origin: 'manifest', manifestPath };
		}
	}

	return { root: startDirectory, origin: 'parent-directory', manifestPath: null };
}

/**
 * The directory itself, then each ancestor, ending at the vault root (`''`).
 * `'a/b'` yields `['a/b', 'a', '']`.
 */
export function ancestorsInclusive(directory: VaultPath): VaultPath[] {
	const trimmed = trimSlashes(directory);
	if (trimmed.length === 0) {
		return [''];
	}

	const segments = trimmed.split('/');
	const result: VaultPath[] = [];
	for (let length = segments.length; length > 0; length -= 1) {
		result.push(segments.slice(0, length).join('/'));
	}
	result.push('');
	return result;
}

/** A short label for the status bar and settings, e.g. `papers/thesis`. */
export function describeProject(project: TypstProject): string {
	const location = project.root.length === 0 ? 'vault root' : project.root;
	switch (project.origin) {
		case 'configured':
			return `${location} (configured)`;
		case 'vault':
			return `${location} (whole vault)`;
		case 'manifest':
			return `${location} (${TYPST_MANIFEST_NAME})`;
		case 'parent-directory':
			return `${location} (file's folder)`;
	}
}

function trimSlashes(value: string): string {
	return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}
