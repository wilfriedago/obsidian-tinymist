import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { LogSink, Logger } from '../../src/shared/logging'
import { absolutePathToFileUri } from '../../src/shared/paths'
import { DocumentSession } from '../../src/typst/documents/session'
import { resolveMainDocument } from '../../src/typst/project/main-document'
import { resolveProject } from '../../src/typst/project/project'
import type { TinymistClient } from '../../src/typst/tinymist/client'
import { buildPreviewArgs } from '../../src/typst/tinymist/config'
import { TinymistManager } from '../../src/typst/tinymist/manager'
import {
	TINYMIST_COMMAND,
	TINYMIST_NOTIFICATION,
	type CompileStatusParams,
	type PublishDiagnosticsParams,
	type StartPreviewResult
} from '../../src/typst/tinymist/protocol'
import { NodeTestHost } from '../helpers/node-host'

/**
 * A chapter that only compiles as part of its project's main document.
 *
 * `project/chapters/background.typ` cites the bibliography `project/main.typ`
 * declares and refers to a label in it, so on its own it fails with "label does
 * not exist" and a preview of it stays blank. These pin down the Tinymist
 * behaviour the plugin's answer relies on. Nothing is written to the vault.
 */

const VAULT = resolve(__dirname, '../../test-vault')
const MAIN = 'project/main.typ'
const CHAPTER = 'project/chapters/background.typ'
// Outside the project, and on disk: a preview of a file that exists only in
// memory recompiles in a loop.
const STANDALONE = 'basic.typ'
const host = new NodeTestHost(VAULT)

let available = false
let manager: TinymistManager
let client: TinymistClient
let session: DocumentSession
const statuses: CompileStatusParams[] = []
const diagnosticsByUri = new Map<string, PublishDiagnosticsParams>()

const absolute = (relative: string) => resolve(VAULT, relative)
const chapterErrors = () => diagnosticsByUri.get(absolutePathToFileUri(absolute(CHAPTER)))?.diagnostics ?? []

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 25_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (predicate()) {
			return
		}
		await new Promise((r) => setTimeout(r, 100))
	}
	throw new Error(`Timed out waiting for ${label}`)
}

/** Resolves with the next finished compile after `action`. */
async function nextOutcome(action: () => unknown): Promise<CompileStatusParams> {
	const from = statuses.length
	await action()
	await waitFor('a compile to finish', () => statuses.slice(from).some((status) => status.status !== 'compiling'))
	return statuses.slice(from).find((status) => status.status !== 'compiling') as CompileStatusParams
}

/** Lets compiles triggered by an earlier step finish, so they are not read as the next one's. */
async function settle(quietMs = 1_000): Promise<void> {
	let seen = statuses.length
	let quietSince = Date.now()
	while (Date.now() - quietSince < quietMs) {
		await new Promise((r) => setTimeout(r, 100))
		if (statuses.length !== seen) {
			seen = statuses.length
			quietSince = Date.now()
		}
	}
}

async function tinymistIsAvailable(): Promise<boolean> {
	return await new Promise((done) => {
		try {
			const child = host.spawn('tinymist', ['probe'])
			child.on('error', () => done(false))
			child.on('exit', (code) => done(code === 0))
		} catch {
			done(false)
		}
	})
}

beforeAll(async () => {
	available = await tinymistIsAvailable()
	if (!available) {
		return
	}

	const sink = new LogSink()
	sink.setLevel('silent')
	session = new DocumentSession(VAULT, new Logger(sink, 'session'))
	manager = new TinymistManager({
		host,
		logger: new Logger(sink, 'test'),
		getInitOptions: () => ({
			executablePath: '',
			projectRootStrategy: 'auto',
			customProjectRoot: '',
			vaultBasePath: VAULT,
			formatterEnabled: false,
			logLevel: 'silent',
			systemFonts: false,
			fontPaths: [],
			exportStagingDirectory: ''
		}),
		onClientReady: (ready) => {
			ready.onNotification('textDocument/publishDiagnostics', (params) => {
				const typed = params as PublishDiagnosticsParams
				diagnosticsByUri.set(typed.uri, typed)
			})
			ready.onNotification(TINYMIST_NOTIFICATION.compileStatus, (params) => {
				statuses.push(params as CompileStatusParams)
			})
		},
		onClientGone: () => undefined
	})
	client = await manager.ensureStarted()
	session.attach(client)
}, 90_000)

afterAll(async () => {
	if (available && manager) {
		session.closeAll()
		await manager.stop()
	}
})

describe.runIf(process.env['SKIP_TINYMIST_TESTS'] !== '1')('main documents, live', () => {
	it('finds main.typ as the chapter’s main document in the fixture', async () => {
		if (!available) return
		const source = {
			exists: (path: string) => {
				try {
					statSync(absolute(path))
					return true
				} catch {
					return false
				}
			},
			read: async (path: string) => readFileSync(absolute(path), 'utf8')
		}
		const project = resolveProject(source, CHAPTER, { strategy: 'auto', customRoot: '' })
		expect(await resolveMainDocument(source, CHAPTER, project)).toBe(MAIN)
	})

	it('fails to compile the chapter on its own, which is the blank preview', async () => {
		if (!available) return
		const outcome = await nextOutcome(() => session.open(CHAPTER, readFileSync(absolute(CHAPTER), 'utf8')))
		expect(outcome).toMatchObject({ status: 'compileError', path: '/chapters/background.typ' })
		await waitFor('the chapter’s diagnostics', () => chapterErrors().length > 0)
		expect(chapterErrors().map((diagnostic) => diagnostic.message)).toContain('label `<knuth1984>` does not exist in the document')
	})

	it('compiles the chapter cleanly once main.typ is pinned', async () => {
		if (!available) return
		await settle()
		// The path is relative to the project root, which is how the plugin
		// matches a status to the document it is about.
		const outcome = await nextOutcome(() => client.executeCommand(TINYMIST_COMMAND.pinMain, [absolute(MAIN)]))
		expect(outcome).toMatchObject({ status: 'compileSuccess', path: '/main.typ' })
		await waitFor('the chapter’s diagnostics to clear', () => chapterErrors().length === 0)
	})

	it('scrolls a preview of main.typ to a caret in the chapter', async () => {
		if (!available) return
		await settle()
		const preview = await client.executeCommand<StartPreviewResult>(
			TINYMIST_COMMAND.startPreview,
			[
				buildPreviewArgs({
					taskId: 'vitest-main-document',
					entryAbsolutePath: absolute(MAIN),
					notPrimary: false,
					invertColors: 'never',
					refreshOnType: true,
					partialRendering: false
				})
			],
			60_000
		)

		const messages: string[] = []
		const socket = new WebSocket(`ws://127.0.0.1:${preview.dataPlanePort}`)
		socket.binaryType = 'arraybuffer'
		socket.addEventListener('message', (event) => {
			messages.push(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer))
		})
		try {
			await new Promise<void>((done, fail) => {
				socket.addEventListener('open', () => done(), { once: true })
				socket.addEventListener('error', () => fail(new Error('preview websocket refused')), { once: true })
			})
			socket.send('current')
			await waitFor('the document to render', () => messages.some((message) => message.startsWith('new,')))

			await client.executeCommand(TINYMIST_COMMAND.scrollPreview, [
				'vitest-main-document',
				{ event: 'panelScrollTo', filepath: absolute(CHAPTER), line: 6, character: 3 }
			])
			await waitFor('a jump into the chapter', () => messages.some((message) => message.startsWith('jump,')))
		} finally {
			socket.close()
			await client.executeCommand(TINYMIST_COMMAND.killPreview, ['vitest-main-document'])
		}
	}, 90_000)

	it('keeps the compiler on a stopped primary preview’s document until it is pinned again', async () => {
		if (!available) return
		// Why the plugin pins after closing a primary preview: otherwise an edit
		// to another file is never compiled at all.
		session.open(STANDALONE, readFileSync(absolute(STANDALONE), 'utf8'))
		await settle()
		await nextOutcome(() =>
			client.executeCommand(TINYMIST_COMMAND.startPreview, [
				buildPreviewArgs({
					taskId: 'vitest-lock',
					entryAbsolutePath: absolute(STANDALONE),
					notPrimary: false,
					invertColors: 'never',
					refreshOnType: true,
					partialRendering: false
				})
			])
		)
		expect(statuses.at(-1)?.path).toBe('/basic.typ')
		await client.executeCommand(TINYMIST_COMMAND.killPreview, ['vitest-lock'])
		await settle()

		const from = statuses.length
		session.change(CHAPTER, `${readFileSync(absolute(CHAPTER), 'utf8')}\nEdited.\n`)
		await settle(2_000)
		expect(statuses.slice(from).some((status) => status.path === '/main.typ')).toBe(false)

		const outcome = await nextOutcome(() => client.executeCommand(TINYMIST_COMMAND.pinMain, [absolute(MAIN)]))
		expect(outcome).toMatchObject({ status: 'compileSuccess', path: '/main.typ' })
		session.close(STANDALONE)
	}, 90_000)
})
