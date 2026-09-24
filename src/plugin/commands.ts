import { Notice, type Plugin } from 'obsidian';

import { TypstEditorView } from '../editor/typst-editor-view';
import { BIBLATEX_EXTENSION } from './constants';
import type { TypstRuntime } from './runtime';

/**
 * User-facing commands.
 *
 * IDs are stable and deliberately unprefixed: Obsidian already prefixes them
 * with the plugin id, so adding it here would produce `tinymist:tinymist-…`.
 * None of them declare a default hotkey, which would collide with whatever the
 * user has already bound.
 *
 * Commands that need an open Typst document use `checkCallback`, so they are
 * hidden in the palette rather than failing when the document is not there.
 */
export function registerCommands(plugin: Plugin, runtime: TypstRuntime): void {
	const withActiveDocument = (
		run: (view: TypstEditorView, vaultPath: string) => void | Promise<void>,
	) =>
		(checking: boolean): boolean => {
			const view = runtime.activeEditor();
			const vaultPath = view?.vaultPath;
			if (!view || !vaultPath) {
				return false;
			}
			if (!checking) {
				void run(view, vaultPath);
			}
			return true;
		};

	plugin.addCommand({
		id: 'open-preview',
		name: 'Open preview',
		checkCallback: withActiveDocument((_view, vaultPath) => runtime.openPreview(vaultPath)),
	});

	plugin.addCommand({
		id: 'toggle-preview',
		name: 'Toggle preview',
		checkCallback: withActiveDocument((_view, vaultPath) => runtime.togglePreview(vaultPath)),
	});

	// The preview replaces the editor in its own tab rather than splitting it,
	// which is the only way it fits on a narrow window.
	plugin.addCommand({
		id: 'open-preview-here',
		name: 'Open preview in this tab',
		checkCallback: withActiveDocument((_view, vaultPath) =>
			runtime.openPreview(vaultPath, 'here'),
		),
	});

	plugin.addCommand({
		id: 'export-pdf',
		name: 'Export PDF',
		checkCallback: withActiveDocument((_view, vaultPath) => runtime.exportPdf(vaultPath)),
	});

	plugin.addCommand({
		id: 'format-document',
		name: 'Format document',
		checkCallback: withActiveDocument((view) => runtime.formatDocument(view)),
	});

	plugin.addCommand({
		id: 'show-project',
		name: 'Show project root',
		checkCallback: withActiveDocument((_view, vaultPath) => {
			new Notice(`Project root: ${runtime.describeProjectFor(vaultPath)}`);
		}),
	});

	// Deliberately unconditional: the point of this command is to make a Typst
	// file when there is not one open yet.
	plugin.addCommand({
		id: 'create-file',
		name: 'Create new Typst file',
		callback: () => {
			void runtime.createFileInDefaultFolder();
		},
	});

	// Offered only while `.bib` files open here; when another plugin has them,
	// a new one would open somewhere this plugin cannot see it.
	plugin.addCommand({
		id: 'create-bibliography',
		name: 'Create new BibLaTeX file',
		checkCallback: (checking) => {
			if (!runtime.ownsExtension(BIBLATEX_EXTENSION)) {
				return false;
			}
			if (!checking) {
				void runtime.createFileInDefaultFolder(BIBLATEX_EXTENSION);
			}
			return true;
		},
	});

	plugin.addCommand({
		id: 'restart-server',
		name: 'Restart language server',
		callback: () => {
			void runtime.restartServer();
		},
	});
}
