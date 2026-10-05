import { Notice, type App, type WorkspaceLeaf } from 'obsidian'

import { absoluteToVaultPath, fileUriToAbsolutePath } from '../shared/paths'

/**
 * Opens a file a Typst document links to, once Tinymist has resolved it to a
 * `file:` URI. Mod-click on a path lands here; so should the hover's own
 * "Open in Tab" link (#33), so there is one way of opening a linked file.
 *
 * The file opens in whichever view owns its extension — the Typst editor, the
 * data file editor, Obsidian's image or PDF view — because that is what
 * `openFile` picks. Nothing outside the vault is opened: the plugin has no
 * business there, and Obsidian could not show it anyway.
 */

/** In place of the document the link was followed from, or in a new tab. */
export type LinkedFilePlacement = WorkspaceLeaf | 'tab'

export async function openLinkedFile(app: App, vaultBasePath: string, uri: string, placement: LinkedFilePlacement): Promise<void> {
	const absolute = fileUriToAbsolutePath(uri)
	if (absolute === null) {
		new Notice('Only files on this device can be opened')
		return
	}

	const vaultPath = absoluteToVaultPath(vaultBasePath, absolute)
	if (vaultPath === null) {
		new Notice(`${absolute} is outside the vault`)
		return
	}

	const file = app.vault.getFileByPath(vaultPath)
	if (!file) {
		new Notice(`${vaultPath} does not exist`)
		return
	}

	const leaf = placement === 'tab' ? app.workspace.getLeaf('tab') : placement
	await leaf.openFile(file, { active: true })
}
