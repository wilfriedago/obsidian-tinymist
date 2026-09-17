import { Notice, TFile, normalizePath, type Vault } from 'obsidian';

import { TypstError, asTypstError } from '../../shared/errors';
import type { Logger } from '../../shared/logging';
import { containVaultPath, parentVaultPath, withExtension, type VaultPath } from '../../shared/paths';
import type { TinymistClient } from '../tinymist/client';
import { TINYMIST_COMMAND, type ExportResult } from '../tinymist/protocol';

/**
 * PDF export.
 *
 * Tinymist does the compiling; this module decides where the result lands and
 * writes it through Obsidian's Vault API so the file is indexed, linkable, and
 * opens in Obsidian's own PDF viewer like any other PDF in the vault.
 *
 * Why the bytes make a round trip instead of letting Tinymist write directly:
 * `tinymist.exportPdf` writes to its configured `outputPath` regardless of the
 * `write` action flag (verified against 0.15.8), and that path is global
 * server configuration rather than a per-call argument. Routing every export
 * through a plugin-owned staging directory is what makes the destination, the
 * overwrite policy, and vault cleanliness ours to control.
 */

export interface ExportRequest {
	/** Vault-relative path of the `.typ` source. */
	readonly sourceVaultPath: VaultPath;
	/** Absolute filesystem path of the same file, for Tinymist. */
	readonly sourceAbsolutePath: string;
}

export interface ExportDestinationOptions {
	/** Vault-relative folder, or `''` to write beside the source. */
	readonly exportFolder: string;
	readonly overwrite: boolean;
}

export interface ExportOutcome {
	readonly file: TFile;
	/** True when an existing file was replaced rather than a new one created. */
	readonly replaced: boolean;
}

/** Exports queued so two exports cannot race through the shared staging path. */
export class PdfExporter {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly vault: Vault,
		private readonly logger: Logger,
	) {}

	/**
	 * Compiles `request` and writes the PDF into the vault.
	 * Serialized: Tinymist's `outputPath` is global, so concurrent exports
	 * would overwrite one another's staged file.
	 */
	async export(
		client: TinymistClient,
		request: ExportRequest,
		destination: ExportDestinationOptions,
	): Promise<ExportOutcome> {
		const run = this.queue.then(() => this.runExport(client, request, destination));
		// Keep the chain alive even when this export rejects.
		this.queue = run.catch(() => undefined);
		return await run;
	}

	private async runExport(
		client: TinymistClient,
		request: ExportRequest,
		destination: ExportDestinationOptions,
	): Promise<ExportOutcome> {
		if (!client.supportsCommand(TINYMIST_COMMAND.exportPdf)) {
			throw new TypstError(
				'export-failed',
				'This Tinymist build does not provide the PDF export command.',
			);
		}

		let result: ExportResult | null;
		try {
			// The first argument is a plain filesystem path. Passing a `file:`
			// URI here makes Tinymist treat the URI as the output path and fail
			// with a misleading "output path is relative" error.
			result = await client.executeCommand<ExportResult | null>(
				TINYMIST_COMMAND.exportPdf,
				[request.sourceAbsolutePath, {}, { write: false }],
				120_000,
			);
		} catch (error) {
			throw asTypstError(error, 'export-failed', { Document: request.sourceVaultPath });
		}

		const base64 = result?.data;
		if (!base64) {
			throw new TypstError(
				'export-failed',
				'Tinymist compiled the document but returned no PDF data.',
				{ context: { Document: request.sourceVaultPath } },
			);
		}

		const bytes = decodeBase64(base64);
		const targetPath = await this.resolveTargetPath(request.sourceVaultPath, destination);
		const existing = this.vault.getAbstractFileByPath(targetPath);

		if (existing instanceof TFile) {
			await this.vault.modifyBinary(existing, bytes);
			this.logger.info('Replaced exported PDF', targetPath);
			return { file: existing, replaced: true };
		}

		await this.ensureFolder(parentVaultPath(targetPath));
		const created = await this.vault.createBinary(targetPath, bytes);
		this.logger.info('Wrote exported PDF', targetPath);
		return { file: created, replaced: false };
	}

	/**
	 * Picks the destination path. With overwrite off, an existing PDF is never
	 * clobbered: the export lands on the next free `name-1.pdf`.
	 */
	private async resolveTargetPath(
		sourceVaultPath: VaultPath,
		destination: ExportDestinationOptions,
	): Promise<VaultPath> {
		const folder = containVaultPath(destination.exportFolder);
		const pdfName = withExtension(basename(sourceVaultPath), 'pdf');
		const directory = folder.length > 0 ? folder : parentVaultPath(sourceVaultPath);
		const base = normalizePath(directory.length > 0 ? `${directory}/${pdfName}` : pdfName);

		if (destination.overwrite) {
			return base;
		}

		if (this.vault.getAbstractFileByPath(base) === null) {
			return base;
		}

		const stem = pdfName.slice(0, -'.pdf'.length);
		for (let index = 1; index < 1000; index += 1) {
			const candidate = normalizePath(
				directory.length > 0 ? `${directory}/${stem}-${index}.pdf` : `${stem}-${index}.pdf`,
			);
			if (this.vault.getAbstractFileByPath(candidate) === null) {
				return candidate;
			}
		}

		throw new TypstError(
			'export-failed',
			'Too many exported copies of this document already exist.',
			{ context: { Document: sourceVaultPath } },
		);
	}

	private async ensureFolder(folderPath: VaultPath): Promise<void> {
		if (folderPath.length === 0) {
			return;
		}
		if (this.vault.getAbstractFileByPath(folderPath) !== null) {
			return;
		}
		try {
			await this.vault.createFolder(folderPath);
		} catch (error) {
			// A concurrent create is fine; anything else is not.
			if (this.vault.getAbstractFileByPath(folderPath) === null) {
				throw asTypstError(error, 'export-failed', { Folder: folderPath });
			}
		}
	}
}

/** Announces the result in the way Obsidian users expect: one short notice. */
export function announceExport(outcome: ExportOutcome): void {
	new Notice(
		outcome.replaced
			? `Replaced ${outcome.file.name}`
			: `Exported ${outcome.file.name}`,
	);
}

function basename(vaultPath: VaultPath): string {
	const slash = vaultPath.lastIndexOf('/');
	return slash === -1 ? vaultPath : vaultPath.slice(slash + 1);
}

/** Decodes base64 into the `ArrayBuffer` the Vault binary APIs take. */
export function decodeBase64(base64: string): ArrayBuffer {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes.buffer;
}
