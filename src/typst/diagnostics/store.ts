import type { VaultPath } from '../../shared/paths';
import { DIAGNOSTIC_SEVERITY, type Diagnostic } from '../tinymist/protocol';

/**
 * Diagnostics, keyed by vault-relative path.
 *
 * Worth knowing about Tinymist 0.15.8: it publishes `publishDiagnostics` only
 * for documents that have problems. A clean document produces no notification
 * at all, so "no entry" means "no problems" — the store never waits for an
 * empty array that is not coming.
 */

export interface DiagnosticsSnapshot {
	readonly errors: number;
	readonly warnings: number;
	readonly total: number;
}

export type DiagnosticsListener = (vaultPath: VaultPath, diagnostics: readonly Diagnostic[]) => void;

export class DiagnosticsStore {
	private readonly byDocument = new Map<VaultPath, readonly Diagnostic[]>();
	private readonly listeners = new Set<DiagnosticsListener>();

	set(vaultPath: VaultPath, diagnostics: readonly Diagnostic[]): void {
		if (diagnostics.length === 0) {
			if (!this.byDocument.delete(vaultPath)) {
				return;
			}
		} else {
			this.byDocument.set(vaultPath, diagnostics);
		}
		this.emit(vaultPath, diagnostics);
	}

	get(vaultPath: VaultPath): readonly Diagnostic[] {
		return this.byDocument.get(vaultPath) ?? [];
	}

	clear(vaultPath: VaultPath): void {
		this.set(vaultPath, []);
	}

	clearAll(): void {
		const paths = [...this.byDocument.keys()];
		this.byDocument.clear();
		for (const path of paths) {
			this.emit(path, []);
		}
	}

	summarize(vaultPath: VaultPath): DiagnosticsSnapshot {
		return summarizeDiagnostics(this.get(vaultPath));
	}

	onChange(listener: DiagnosticsListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private emit(vaultPath: VaultPath, diagnostics: readonly Diagnostic[]): void {
		for (const listener of this.listeners) {
			listener(vaultPath, diagnostics);
		}
	}
}

export function summarizeDiagnostics(diagnostics: readonly Diagnostic[]): DiagnosticsSnapshot {
	let errors = 0;
	let warnings = 0;
	for (const diagnostic of diagnostics) {
		// LSP leaves severity optional; Tinymist omits it for plain errors.
		const severity = diagnostic.severity ?? DIAGNOSTIC_SEVERITY.error;
		if (severity === DIAGNOSTIC_SEVERITY.error) {
			errors += 1;
		} else if (severity === DIAGNOSTIC_SEVERITY.warning) {
			warnings += 1;
		}
	}
	return { errors, warnings, total: diagnostics.length };
}
