import { TFolder, normalizePath, type App, type TFile } from 'obsidian';

import { TypstError, asTypstError } from '../shared/errors';
import { TYPST_EXTENSION } from './constants';

/**
 * Creating `.typ` files, and the `.bib` files they cite.
 *
 * Obsidian's own "New note" always produces Markdown, and there is no API to
 * add an entry to that dropdown, so these files need an affordance of their own.
 * The supported route is the `file-menu` event, which fires when the file
 * explorer's context menu opens on a folder.
 *
 * The file is created empty, matching what "New note" does. Seeding a template
 * would be a guess about the document the user wants, and a wrong guess is
 * more annoying than an empty file. Its name, on the other hand, is offered for
 * renaming straight away, since `Untitled` is never the name anyone wants.
 */

/** Obsidian's own naming for new files: `Untitled`, then `Untitled 1`, … */
const BASE_NAME = 'Untitled';

/**
 * Picks a path in `folder` that is not taken.
 *
 * Mirrors Obsidian's convention rather than inventing one, so a vault full of
 * `Untitled 3.md` gains an `Untitled.typ` that looks like it belongs.
 */
export function availableFilePath(
	folderPath: string,
	exists: (path: string) => boolean,
	baseName: string = BASE_NAME,
	extension: string = TYPST_EXTENSION,
): string {
	const directory = folderPath.replace(/\/+$/, '');
	const join = (name: string): string =>
		normalizePath(directory.length > 0 ? `${directory}/${name}` : name);

	const first = join(`${baseName}.${extension}`);
	if (!exists(first)) {
		return first;
	}

	for (let index = 1; index < 1000; index += 1) {
		const candidate = join(`${baseName} ${index}.${extension}`);
		if (!exists(candidate)) {
			return candidate;
		}
	}

	throw new TypstError(
		'document-sync-failed',
		'Too many untitled files already exist in that folder.',
		{ context: { Folder: folderPath || 'vault root' } },
	);
}

/**
 * Creates an empty file with `extension` in `folder` and opens it.
 *
 * Returns the new file so a caller can act on it further.
 */
export async function createFile(
	app: App,
	folder: TFolder,
	extension: string = TYPST_EXTENSION,
): Promise<TFile> {
	const path = availableFilePath(
		folder.path === '/' ? '' : folder.path,
		(candidate) => app.vault.getAbstractFileByPath(candidate) !== null,
		undefined,
		extension,
	);

	try {
		const file = await app.vault.create(path, '');
		// `false` keeps the file in the current tab group rather than splitting,
		// and `rename` selects its name for typing over, both as Obsidian's own
		// "New note" and "New canvas" do. The base view resolves `rename` to the
		// tab title when it is shown and to the rename dialog when it is hidden.
		await app.workspace
			.getLeaf(false)
			.openFile(file, { active: true, eState: { rename: 'all' } });
		return file;
	} catch (error) {
		throw asTypstError(error, 'document-sync-failed', { Path: path });
	}
}

/**
 * The folder a new file should go in when the user did not pick one, honouring
 * their "Default location for new notes" preference.
 */
export function defaultNewFileFolder(app: App): TFolder {
	const activePath = app.workspace.getActiveFile()?.path ?? '';
	return app.fileManager.getNewFileParent(activePath);
}

/** True when the context menu was opened on something we can create inside. */
export function isFolder(target: unknown): target is TFolder {
	return target instanceof TFolder;
}
