import { describe, expect, it } from 'vitest'

import {
	projectEntryPoint,
	readManifestEntrypoint,
	referencedPaths,
	resolveMainDocument,
	resolveReference,
	type MainDocumentSource
} from '../../src/typst/project/main-document'
import { resolveProject, type TypstProject } from '../../src/typst/project/project'

/** A vault whose files are exactly these paths and contents. */
function vault(files: Record<string, string>): MainDocumentSource {
	return {
		exists: (path) => path in files,
		read: async (path) => files[path] ?? null
	}
}

const MANIFEST = '[package]\nname = "thesis"\nversion = "0.1.0"\nentrypoint = "main.typ"\n'

/** The issue's reproduction: a thesis whose chapters only compile through `main.typ`. */
const THESIS = {
	'thesis/typst.toml': MANIFEST,
	'thesis/main.typ': '#include "chapters/intro.typ"\n#include "chapters/method.typ"\n#bibliography("refs.bib")\n',
	'thesis/refs.bib': '@article{knuth1984, title = {Literate Programming}}\n',
	'thesis/chapters/intro.typ': '= Introduction <chap:intro>\nAs shown by @knuth1984, see @chap:method.\n',
	'thesis/chapters/method.typ': '#import "../template.typ": note\n= Method <chap:method>\n',
	'thesis/template.typ': '#let note(body) = body\n',
	'thesis/scratch.typ': '= Not included anywhere\n'
}

function projectOf(files: Record<string, string>, documentPath: string): TypstProject {
	return resolveProject({ exists: (path) => path in files }, documentPath, { strategy: 'auto', customRoot: '' })
}

async function mainOf(files: Record<string, string>, documentPath: string): Promise<string> {
	return await resolveMainDocument(vault(files), documentPath, projectOf(files, documentPath))
}

describe('resolveMainDocument', () => {
	it('compiles an included chapter through the entry point', async () => {
		expect(await mainOf(THESIS, 'thesis/chapters/intro.typ')).toBe('thesis/main.typ')
		expect(await mainOf(THESIS, 'thesis/chapters/method.typ')).toBe('thesis/main.typ')
	})

	it('follows imports as well as includes, through more than one file', async () => {
		expect(await mainOf(THESIS, 'thesis/template.typ')).toBe('thesis/main.typ')
	})

	it('keeps the entry point as its own main document', async () => {
		expect(await mainOf(THESIS, 'thesis/main.typ')).toBe('thesis/main.typ')
	})

	it('leaves a file the entry point never reaches on its own', async () => {
		// Pinned to `main.typ`, Tinymist would report nothing at all for it.
		expect(await mainOf(THESIS, 'thesis/scratch.typ')).toBe('thesis/scratch.typ')
	})

	it('leaves a file alone when its project has no typst.toml', async () => {
		const files = { 'notes/main.typ': '#include "part.typ"\n', 'notes/part.typ': 'Part\n' }
		expect(await mainOf(files, 'notes/part.typ')).toBe('notes/part.typ')
	})

	it('leaves a file alone when the manifest names no entry point, or a missing one', async () => {
		const withoutEntry = { ...THESIS, 'thesis/typst.toml': '[package]\nname = "thesis"\n' }
		expect(await mainOf(withoutEntry, 'thesis/chapters/intro.typ')).toBe('thesis/chapters/intro.typ')
		const missingEntry = { ...THESIS, 'thesis/typst.toml': MANIFEST.replace('main.typ', 'gone.typ') }
		expect(await mainOf(missingEntry, 'thesis/chapters/intro.typ')).toBe('thesis/chapters/intro.typ')
	})

	it('reads what the source gives it, so an unsaved include counts', async () => {
		const unsaved = { ...THESIS, 'thesis/main.typ': `${THESIS['thesis/main.typ']}#include "scratch.typ"\n` }
		expect(await mainOf(unsaved, 'thesis/scratch.typ')).toBe('thesis/main.typ')
	})

	it('survives an include cycle', async () => {
		const files = {
			'p/typst.toml': MANIFEST,
			'p/main.typ': '#include "a.typ"\n',
			'p/a.typ': '#include "main.typ"\n',
			'p/b.typ': 'Unreached\n'
		}
		expect(await mainOf(files, 'p/b.typ')).toBe('p/b.typ')
	})
})

describe('projectEntryPoint', () => {
	it('resolves the entry point against the manifest folder', async () => {
		const files = { ...THESIS, 'thesis/typst.toml': MANIFEST.replace('"main.typ"', '"src/main.typ"'), 'thesis/src/main.typ': '' }
		expect(await projectEntryPoint(vault(files), 'thesis/chapters/intro.typ', projectOf(files, 'thesis/chapters/intro.typ'))).toBe(
			'thesis/src/main.typ'
		)
	})

	it('ignores a manifest above a configured root', async () => {
		const project: TypstProject = { root: 'thesis/chapters', origin: 'configured', manifestPath: null }
		expect(await projectEntryPoint(vault(THESIS), 'thesis/chapters/intro.typ', project)).toBeNull()
	})

	it('finds the manifest under the whole-vault strategy too', async () => {
		const project: TypstProject = { root: '', origin: 'vault', manifestPath: null }
		expect(await projectEntryPoint(vault(THESIS), 'thesis/chapters/intro.typ', project)).toBe('thesis/main.typ')
	})
})

describe('readManifestEntrypoint', () => {
	it('reads the package entry point', () => {
		expect(readManifestEntrypoint(MANIFEST)).toBe('main.typ')
	})

	it("ignores a template's entry point, which names a file to start from", () => {
		const template = '[package]\nname = "t"\nentrypoint = "lib.typ"\n\n[template]\npath = "template"\nentrypoint = "main.typ"\n'
		expect(readManifestEntrypoint(template)).toBe('lib.typ')
		expect(readManifestEntrypoint('[template]\nentrypoint = "main.typ"\n')).toBeNull()
	})

	it('accepts literal strings, comments and CRLF line endings', () => {
		expect(readManifestEntrypoint("[package]\r\nentrypoint = 'thesis.typ' # the document\r\n")).toBe('thesis.typ')
	})

	it('returns null when there is none', () => {
		expect(readManifestEntrypoint('[package]\nname = "x"\n')).toBeNull()
		expect(readManifestEntrypoint('[package]\nentrypoint = ""\n')).toBeNull()
	})
})

describe('referencedPaths', () => {
	it('finds includes and imports in markup and code', () => {
		const source = [
			'#include "chapters/intro.typ"',
			'#import "template.typ": paper',
			'#{',
			'  include "appendix.typ"',
			'}',
			'#import "@preview/cetz:0.3.0"'
		].join('\n')
		expect(referencedPaths(source)).toEqual(['chapters/intro.typ', 'template.typ', 'appendix.typ'])
	})

	it('does not mistake a longer identifier for the keyword', () => {
		expect(referencedPaths('#let my-include = "x.typ"\n#reinclude "y.typ"')).toEqual([])
	})
})

describe('resolveReference', () => {
	it('resolves relative to the naming file', () => {
		expect(resolveReference('thesis/chapters/method.typ', '../template.typ', 'thesis')).toBe('thesis/template.typ')
		expect(resolveReference('thesis/main.typ', './chapters/intro.typ', 'thesis')).toBe('thesis/chapters/intro.typ')
	})

	it('resolves a leading slash against the project root', () => {
		expect(resolveReference('thesis/chapters/intro.typ', '/template.typ', 'thesis')).toBe('thesis/template.typ')
	})

	it('refuses a path that leaves the root, as Typst does', () => {
		expect(resolveReference('thesis/main.typ', '../other/x.typ', 'thesis')).toBeNull()
		expect(resolveReference('main.typ', '../x.typ', '')).toBeNull()
	})
})
