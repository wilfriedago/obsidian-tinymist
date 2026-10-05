import { extensionOf, parentVaultPath, type VaultPath } from '../../shared/paths'
import { TYPST_MANIFEST_NAME, ancestorsInclusive, type TypstProject } from './project'

/**
 * Which file Typst should compile when a document is open.
 *
 * A chapter of a thesis is not a document on its own: its citations resolve
 * against a `#bibliography` in `main.typ`, and its `@chap:…` references against
 * labels in sibling chapters. Compiled alone it fails with "label does not
 * exist", and a failed compile renders nothing. So a file that a project's
 * entry point reaches is compiled, previewed, and diagnosed through that entry
 * point instead.
 *
 * The entry point comes from the `entrypoint` key of the project's
 * `typst.toml`, which Typst itself defines, so the plugin adds no setting of its
 * own. Reachability is a static walk of the `#include` and `#import` paths that
 * are string literals. That misses a path built at run time, and missing it
 * costs only what the plugin did before: the file compiles on its own. The
 * opposite error, claiming a file the entry point does not include, would be
 * worse, because Tinymist then reports nothing at all for the file being edited
 * — verified against 0.15.8.
 */

/** Just enough of the vault to find and read a project's sources. */
export interface MainDocumentSource {
	exists(vaultPath: VaultPath): boolean
	/** The text Tinymist would see: an open buffer before the file on disk. */
	read(vaultPath: VaultPath): Promise<string | null>
}

/** Stops a pathological include graph from becoming a full-vault read. */
const MAX_FILES_WALKED = 1000

/**
 * The main document for `documentVaultPath`: the project's entry point when it
 * reaches the document, and the document itself otherwise.
 */
export async function resolveMainDocument(
	source: MainDocumentSource,
	documentVaultPath: VaultPath,
	project: TypstProject
): Promise<VaultPath> {
	const entry = await projectEntryPoint(source, documentVaultPath, project)
	if (entry === null || entry === documentVaultPath) {
		return documentVaultPath
	}
	return (await reaches(source, entry, documentVaultPath, project.root)) ? entry : documentVaultPath
}

/**
 * The entry point named by the nearest `typst.toml` between the document and
 * its project root, or `null` when there is none or it names no file.
 *
 * The walk stops at the root because a manifest above it describes a different
 * project, and its entry point could not read files Typst confines to the root.
 */
export async function projectEntryPoint(
	source: MainDocumentSource,
	documentVaultPath: VaultPath,
	project: TypstProject
): Promise<VaultPath | null> {
	for (const directory of ancestorsInclusive(parentVaultPath(documentVaultPath))) {
		if (!isWithin(directory, project.root)) {
			break
		}
		const manifestPath = joinVaultPath(directory, TYPST_MANIFEST_NAME)
		if (!source.exists(manifestPath)) {
			continue
		}
		const manifest = await source.read(manifestPath)
		const entrypoint = manifest === null ? null : readManifestEntrypoint(manifest)
		if (entrypoint === null) {
			return null
		}
		const entry = resolveReference(manifestPath, entrypoint, project.root)
		return entry !== null && source.exists(entry) ? entry : null
	}
	return null
}

/** Whether `target` is `entry`, or is reached from it through includes and imports. */
async function reaches(source: MainDocumentSource, entry: VaultPath, target: VaultPath, projectRoot: VaultPath): Promise<boolean> {
	const seen = new Set<VaultPath>([entry])
	const queue: VaultPath[] = [entry]
	while (queue.length > 0 && seen.size <= MAX_FILES_WALKED) {
		const current = queue.shift() as VaultPath
		const text = await source.read(current)
		if (text === null) {
			continue
		}
		for (const reference of referencedPaths(text)) {
			const resolved = resolveReference(current, reference, projectRoot)
			if (resolved === null || seen.has(resolved)) {
				continue
			}
			if (resolved === target) {
				return true
			}
			seen.add(resolved)
			if (extensionOf(resolved) === 'typ' && source.exists(resolved)) {
				queue.push(resolved)
			}
		}
	}
	return false
}

/**
 * The `entrypoint` of a `typst.toml`'s `[package]` table.
 *
 * A deliberately small reader rather than a TOML parser: the key is a plain
 * string in every manifest Typst accepts. Only `[package]` counts, because a
 * template package's manifest also has an `entrypoint` under `[template]`, and
 * that one names the file a new project starts from, not this project's
 * document.
 */
export function readManifestEntrypoint(manifest: string): string | null {
	let table = ''
	for (const rawLine of manifest.split(/\r?\n/)) {
		const line = rawLine.trim()
		const header = /^\[\s*([^\]]+?)\s*\]/.exec(line)
		if (header) {
			table = header[1] ?? ''
			continue
		}
		if (table !== 'package') {
			continue
		}
		const entry = /^entrypoint\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(line)
		if (entry) {
			const value = entry[1] ?? entry[2] ?? ''
			return value.trim().length > 0 ? value.trim() : null
		}
	}
	return null
}

/**
 * The file paths a Typst source includes or imports as string literals.
 *
 * Matches both markup (`#include "a.typ"`) and code (`include "a.typ"`) forms.
 * Package imports (`"@preview/…"`) are not files in the vault and are dropped.
 * Comments are not stripped: a commented-out include at worst makes a file
 * count as part of the document, which is what its author once meant.
 */
export function referencedPaths(source: string): string[] {
	const paths: string[] = []
	for (const match of source.matchAll(/(?<![\w-])(?:include|import)\s+"((?:[^"\\\n]|\\.)*)"/g)) {
		const path = match[1]
		if (path !== undefined && path.length > 0 && !path.startsWith('@')) {
			paths.push(path)
		}
	}
	return paths
}

/**
 * Resolves a Typst path the way the compiler does: relative to the file that
 * names it, or, with a leading `/`, relative to the project root. `null` when
 * the path would leave the root, which Typst refuses too.
 */
export function resolveReference(fromVaultPath: VaultPath, reference: string, projectRoot: VaultPath): VaultPath | null {
	const unified = reference.replace(/\\/g, '/')
	const base = unified.startsWith('/') ? projectRoot : parentVaultPath(fromVaultPath)
	const segments = base.length > 0 ? base.split('/') : []
	for (const segment of unified.split('/')) {
		if (segment === '' || segment === '.') {
			continue
		}
		if (segment === '..') {
			if (segments.length === 0) {
				return null
			}
			segments.pop()
			continue
		}
		segments.push(segment)
	}
	const resolved = segments.join('/')
	return isWithin(resolved, projectRoot) ? resolved : null
}

function isWithin(vaultPath: VaultPath, root: VaultPath): boolean {
	return root.length === 0 || vaultPath === root || vaultPath.startsWith(`${root}/`)
}

function joinVaultPath(directory: VaultPath, name: string): VaultPath {
	return directory.length > 0 ? `${directory}/${name}` : name
}
