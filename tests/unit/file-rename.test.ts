import type { App, Plugin } from 'obsidian'
import { describe, expect, it, vi } from 'vitest'

import { TypstRuntime } from '../../src/plugin/runtime'
import type { DiagnosticsStore } from '../../src/typst/diagnostics/store'
import { DIAGNOSTIC_SEVERITY, type Diagnostic } from '../../src/typst/tinymist/protocol'

/**
 * A rename can change the extension. The old path decides what Tinymist has
 * to be told, since that is the name it knows the buffer by.
 */
describe('renaming a file', () => {
	const problem: Diagnostic = {
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		severity: DIAGNOSTIC_SEVERITY.error,
		message: 'broken'
	}

	function runtimeTracking(oldPath: string) {
		const runtime = new TypstRuntime({} as App, {} as Plugin)
		const session = { rename: vi.fn(), close: vi.fn() }
		const internals = runtime as unknown as {
			session: typeof session
			diagnostics: DiagnosticsStore
			onFileRenamed(oldPath: string, newPath: string): void
		}
		internals.session = session
		internals.diagnostics.set(oldPath, [problem])
		const rename = (newPath: string) => internals.onFileRenamed(oldPath, newPath)
		return { session, diagnostics: internals.diagnostics, rename }
	}

	it('moves a document that keeps a tracked extension', () => {
		const { session, diagnostics, rename } = runtimeTracking('refs.bib')
		rename('sources/refs.bib')
		expect(session.rename).toHaveBeenCalledWith('refs.bib', 'sources/refs.bib')
		expect(session.close).not.toHaveBeenCalled()
		expect(diagnostics.get('refs.bib')).toEqual([])
	})

	it('closes a document renamed to an extension that is not tracked', () => {
		const { session, diagnostics, rename } = runtimeTracking('refs.bib')
		rename('refs.txt')
		expect(session.close).toHaveBeenCalledWith('refs.bib')
		expect(session.rename).not.toHaveBeenCalled()
		expect(diagnostics.get('refs.bib')).toEqual([])
	})

	it('leaves Tinymist alone for a file it never had', () => {
		const { session, diagnostics, rename } = runtimeTracking('notes.txt')
		rename('notes.bib')
		expect(session.rename).not.toHaveBeenCalled()
		expect(session.close).not.toHaveBeenCalled()
		expect(diagnostics.get('notes.txt')).toEqual([problem])
	})
})
