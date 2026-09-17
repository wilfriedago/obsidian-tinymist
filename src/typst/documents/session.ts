import { TypstError } from '../../shared/errors';
import type { Logger } from '../../shared/logging';
import { absolutePathToFileUri, vaultPathToAbsolute, type VaultPath } from '../../shared/paths';
import type { TinymistClient } from '../tinymist/client';

/**
 * Tracks which documents Tinymist has been told about.
 *
 * Documents are keyed by vault-relative path. Basenames would collide the
 * moment a vault has `papers/a/main.typ` and `papers/b/main.typ`, which is the
 * normal shape of a vault with more than one paper in it.
 *
 * The session also survives a restart: after Tinymist comes back, every open
 * document is re-announced from the text the editor currently holds, so an
 * unsaved buffer is not silently replaced by what is on disk.
 */

interface TrackedDocument {
	readonly vaultPath: VaultPath;
	readonly uri: string;
	version: number;
	/** Latest text handed to Tinymist. Kept for re-announcing after a restart. */
	text: string;
}

export class DocumentSession {
	private readonly documents = new Map<VaultPath, TrackedDocument>();
	private client: TinymistClient | null = null;

	constructor(
		private readonly vaultBasePath: string,
		private readonly logger: Logger,
	) {}

	/**
	 * Binds a freshly initialized client and replays every open document into
	 * it. Called on first start and after every restart.
	 */
	attach(client: TinymistClient): void {
		this.client = client;
		for (const document of this.documents.values()) {
			document.version += 1;
			this.sendDidOpen(document);
		}
		if (this.documents.size > 0) {
			this.logger.info('Re-announced open documents', `count=${this.documents.size}`);
		}
	}

	/** Unbinds the client without forgetting the documents. */
	detach(): void {
		this.client = null;
	}

	get openCount(): number {
		return this.documents.size;
	}

	uriFor(vaultPath: VaultPath): string {
		return absolutePathToFileUri(this.absolutePathFor(vaultPath));
	}

	absolutePathFor(vaultPath: VaultPath): string {
		return vaultPathToAbsolute(this.vaultBasePath, vaultPath);
	}

	isOpen(vaultPath: VaultPath): boolean {
		return this.documents.has(vaultPath);
	}

	/** Announces a document. Opening one that is already open re-syncs its text. */
	open(vaultPath: VaultPath, text: string): void {
		const existing = this.documents.get(vaultPath);
		if (existing) {
			this.change(vaultPath, text);
			return;
		}

		const document: TrackedDocument = {
			vaultPath,
			uri: this.uriFor(vaultPath),
			version: 1,
			text,
		};
		this.documents.set(vaultPath, document);
		this.sendDidOpen(document);
	}

	/**
	 * Sends a full-text change. Tinymist accepts incremental sync, but the
	 * editor hands us whole documents and a full replace cannot drift out of
	 * step with the buffer — which matters more here than the saved bytes.
	 */
	change(vaultPath: VaultPath, text: string): void {
		const document = this.documents.get(vaultPath);
		if (!document) {
			this.open(vaultPath, text);
			return;
		}
		if (document.text === text) {
			return;
		}

		document.text = text;
		document.version += 1;

		this.client?.notify('textDocument/didChange', {
			textDocument: { uri: document.uri, version: document.version },
			contentChanges: [{ text }],
		});
	}

	/** Tells Tinymist the file was saved, so on-save tasks can run. */
	save(vaultPath: VaultPath): void {
		const document = this.documents.get(vaultPath);
		if (!document) {
			return;
		}
		this.client?.notify('textDocument/didSave', {
			textDocument: { uri: document.uri },
		});
	}

	close(vaultPath: VaultPath): void {
		const document = this.documents.get(vaultPath);
		if (!document) {
			return;
		}
		this.documents.delete(vaultPath);
		this.client?.notify('textDocument/didClose', {
			textDocument: { uri: document.uri },
		});
	}

	/** Closes everything. Used when the plugin unloads. */
	closeAll(): void {
		// The spread is load-bearing: `close` deletes from the same map, and
		// iterating a live `Map` while removing from it skips entries.
		// oxlint-disable-next-line unicorn/no-useless-spread
		for (const vaultPath of [...this.documents.keys()]) {
			this.close(vaultPath);
		}
	}

	/** Renames in place, so a moved file keeps its identity with the server. */
	rename(oldVaultPath: VaultPath, newVaultPath: VaultPath): void {
		const document = this.documents.get(oldVaultPath);
		if (!document) {
			return;
		}
		const text = document.text;
		this.close(oldVaultPath);
		this.open(newVaultPath, text);
	}

	/** The client, or a categorized error when Tinymist is not available. */
	requireClient(): TinymistClient {
		if (!this.client) {
			throw new TypstError('document-sync-failed', 'Tinymist is not running.');
		}
		return this.client;
	}

	private sendDidOpen(document: TrackedDocument): void {
		this.client?.notify('textDocument/didOpen', {
			textDocument: {
				uri: document.uri,
				languageId: 'typst',
				version: document.version,
				text: document.text,
			},
		});
	}
}
