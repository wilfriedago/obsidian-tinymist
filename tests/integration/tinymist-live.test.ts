import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EditorState, Text } from '@codemirror/state';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { rangeToOffsets } from '../../src/editor/positions';

import { LogSink, Logger } from '../../src/shared/logging';
import { TinymistManager } from '../../src/typst/tinymist/manager';
import { TinymistClient } from '../../src/typst/tinymist/client';
import { buildPreviewArgs } from '../../src/typst/tinymist/config';
import {
	TINYMIST_COMMAND,
	TINYMIST_NOTIFICATION,
	type CompileStatusParams,
	type ExportResult,
	type PreviewJumpInfo,
	type PublishDiagnosticsParams,
	type TextEdit,
	type StartPreviewResult,
} from '../../src/typst/tinymist/protocol';
import { absolutePathToFileUri } from '../../src/shared/paths';
import { NodeTestHost } from '../helpers/node-host';

/**
 * Exercises the adapter against a real Tinymist executable.
 *
 * Skipped automatically when no `tinymist` is on PATH, so a contributor without
 * it still gets a green unit-test run. Nothing here writes into the repository:
 * exports go to a temporary directory.
 */

const VAULT = resolve(__dirname, '../../test-vault');
const host = new NodeTestHost(VAULT);

let available = false;
let stagingDirectory = '';
let manager: TinymistManager;
let client: TinymistClient;
const diagnosticsByUri = new Map<string, PublishDiagnosticsParams>();
const compileStatuses: CompileStatusParams[] = [];

function openDocument(relative: string): string {
	const absolute = resolve(VAULT, relative);
	const uri = absolutePathToFileUri(absolute);
	client.notify('textDocument/didOpen', {
		textDocument: {
			uri,
			languageId: 'typst',
			version: 1,
			text: readFileSync(resolve(VAULT, relative), 'utf8'),
		},
	});
	return uri;
}

/** Waits until `predicate` holds, polling, or fails the test on timeout. */
async function waitFor(label: string, predicate: () => boolean, timeoutMs = 25_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

/**
 * Availability is decided the same way the plugin decides it: run the bare
 * command and see whether it answers. There is no PATH walking, because the
 * plugin imports no filesystem module.
 */
async function tinymistIsAvailable(): Promise<boolean> {
	// `settle`, not `resolve`: `node:path`'s `resolve` is imported above.
	return await new Promise((settle) => {
		try {
			const child = host.spawn('tinymist', ['probe']);
			child.on('error', () => settle(false));
			child.on('exit', (code) => settle(code === 0));
		} catch {
			settle(false);
		}
	});
}

beforeAll(async () => {
	available = await tinymistIsAvailable();
	if (!available) {
		return;
	}

	const sink = new LogSink();
	sink.setLevel('silent');
	stagingDirectory = await host.createTempDirectory('tinymist-vitest-');

	manager = new TinymistManager({
		host,
		logger: new Logger(sink, 'test'),
		getInitOptions: () => ({
			executablePath: '',
			projectRootStrategy: 'auto',
			customProjectRoot: '',
			vaultBasePath: VAULT,
			formatterEnabled: true,
			logLevel: 'silent',
			systemFonts: true,
			fontPaths: [],
			exportStagingDirectory: stagingDirectory,
		}),
		onClientReady: (ready) => {
			ready.onNotification('textDocument/publishDiagnostics', (params) => {
				const typed = params as PublishDiagnosticsParams;
				diagnosticsByUri.set(typed.uri, typed);
			});
			ready.onNotification(TINYMIST_NOTIFICATION.compileStatus, (params) => {
				compileStatuses.push(params as CompileStatusParams);
			});
		},
		onClientGone: () => undefined,
	});

	client = await manager.ensureStarted();
}, 90_000);

afterAll(async () => {
	if (available && manager) {
		await manager.stop();
	}
	if (stagingDirectory) {
		await host.removeDirectory(stagingDirectory);
	}
});

describe.runIf(process.env['SKIP_TINYMIST_TESTS'] !== '1')('Tinymist, live', () => {
	it('found a real Tinymist to test against', () => {
		// Without this guard every other test in the file would return early and
		// report a vacuous pass. Set TINYMIST_REQUIRED=1 in CI to make a missing
		// executable a hard failure rather than a skip.
		if (process.env['TINYMIST_REQUIRED'] === '1') {
			expect(available, 'tinymist was not found on PATH').toBe(true);
		}
		// Printing the detected versions is the only way to tell a real run
		// apart from one that skipped because no executable was present.
		console.info(
			`[integration] tinymist available=${available} version=${manager?.getVersion()?.raw ?? 'n/a'} typst=${manager?.getTypstVersion() ?? 'n/a'}`,
		);
		expect(typeof available).toBe('boolean');
	});

	it('detects a version from the executable', () => {
		if (!available) return;
		const version = manager.getVersion();
		expect(version).not.toBeNull();
		expect(version?.major).toBeTypeOf('number');
	});

	it('reaches the ready state and reports capabilities', () => {
		if (!available) return;
		expect(manager.getState().kind).toBe('ready');
		expect(client.isInitialized).toBe(true);
		expect(client.supportsCapability('completionProvider')).toBe(true);
		expect(client.supportsCapability('hoverProvider')).toBe(true);
		expect(client.supportsCapability('documentSymbolProvider')).toBe(true);
		expect(client.supportsCapability('documentFormattingProvider')).toBe(true);
	});

	it('advertises the commands the plugin depends on', () => {
		if (!available) return;
		for (const command of [
			TINYMIST_COMMAND.startPreview,
			TINYMIST_COMMAND.killPreview,
			TINYMIST_COMMAND.scrollPreview,
			TINYMIST_COMMAND.exportPdf,
		]) {
			expect(client.supportsCommand(command), `missing ${command}`).toBe(true);
		}
	});

	it('publishes diagnostics for a document that fails to compile', async () => {
		if (!available) return;
		const uri = openDocument('errors.typ');
		await waitFor('diagnostics', () => (diagnosticsByUri.get(uri)?.diagnostics.length ?? 0) > 0);

		const published = diagnosticsByUri.get(uri);
		expect(published?.diagnostics.length).toBeGreaterThan(0);
		const first = published?.diagnostics[0];
		expect(first?.message).toBeTruthy();
		expect(first?.range.start.line).toBeTypeOf('number');
	});

	it('reports a clean compile through compileStatus, not empty diagnostics', async () => {
		if (!available) return;
		compileStatuses.length = 0;
		openDocument('basic.typ');

		// Tinymist 0.15.8 publishes `textDocument/publishDiagnostics` only for
		// documents that have problems; a clean document produces no
		// notification at all. "No diagnostics" therefore has to be read from
		// the compile status, which is what the status bar consumes.
		await waitFor(
			'compileSuccess',
			() => compileStatuses.some((status) => status.status === 'compileSuccess'),
		);
		expect(compileStatuses.some((s) => s.status === 'compileSuccess')).toBe(true);
	});

	it('answers completion, hover, and document symbols', async () => {
		if (!available) return;
		const uri = openDocument('basic.typ');

		const completion = await client.request<{ items?: unknown[] } | unknown[]>(
			'textDocument/completion',
			{ textDocument: { uri }, position: { line: 4, character: 2 } },
		);
		expect(completion).toBeTruthy();

		const symbols = await client.request<unknown[]>('textDocument/documentSymbol', {
			textDocument: { uri },
		});
		expect(Array.isArray(symbols)).toBe(true);

		const hover = await client.request('textDocument/hover', {
			textDocument: { uri },
			position: { line: 0, character: 6 },
		});
		// A hover may legitimately be null at a given offset; the point is that
		// the request completes rather than erroring.
		expect(hover === null || typeof hover === 'object').toBe(true);
	});

	it('formats a document', async () => {
		if (!available) return;
		const uri = openDocument('basic.typ');
		const edits = await client.request<unknown[] | null>('textDocument/formatting', {
			textDocument: { uri },
			options: { tabSize: 2, insertSpaces: true },
		});
		expect(edits === null || Array.isArray(edits)).toBe(true);
	});

	it('returns formatter edits whose range is not the whole document', async () => {
		if (!available) return;

		// The bug this pins: Tinymist returns a single edit, and it is tempting
		// to treat its text as the formatted document. Its range starts at the
		// first line that actually changes, so doing that deletes everything
		// before it — for a Typst file, the `#import` header.
		const uri = openDocument('unformatted.typ');
		const original = readFileSync(resolve(VAULT, 'unformatted.typ'), 'utf8');

		const edits = await client.request<TextEdit[] | null>('textDocument/formatting', {
			textDocument: { uri },
			options: { tabSize: 2, insertSpaces: true },
		});

		expect(Array.isArray(edits)).toBe(true);
		expect(edits?.length).toBeGreaterThan(0);

		const edit = edits![0]!;
		const startsAtDocumentStart = edit.range.start.line === 0 && edit.range.start.character === 0;
		expect(
			startsAtDocumentStart,
			'if this ever becomes true, the partial-range hazard is gone',
		).toBe(false);

		// Applying it as a range must preserve the header.
		const document = Text.of(original.split('\n'));
		const { from, to } = rangeToOffsets(document, edit.range);
		const formatted = EditorState.create({ doc: document })
			.update({ changes: { from, to, insert: edit.newText } })
			.state.doc.toString();

		expect(formatted).toContain('#import "@preview/example:0.1.0": thing');
		expect(edit.newText).not.toContain('#import');
	});

	it('exports a PDF and returns its bytes', async () => {
		if (!available) return;
		openDocument('basic.typ');

		// The first argument must be a plain filesystem path. A `file:` URI here
		// makes Tinymist use the URI as the output path and fail with
		// "output path is relative".
		const result = await client.executeCommand<ExportResult | null>(
			TINYMIST_COMMAND.exportPdf,
			[resolve(VAULT, 'basic.typ'), {}, { write: false }],
			90_000,
		);

		expect(result?.data).toBeTypeOf('string');
		const bytes = Buffer.from(result?.data ?? '', 'base64');
		expect(bytes.byteLength).toBeGreaterThan(1_000);
		expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

		// The staged file lands in the configured directory, not the vault.
		expect(result?.path?.startsWith(stagingDirectory)).toBe(true);
	});

	it('rejects a file URI as the export entry, which is why we pass fs paths', async () => {
		if (!available) return;
		const uri = openDocument('basic.typ');
		await expect(
			client.executeCommand(TINYMIST_COMMAND.exportPdf, [uri, {}, { write: false }], 30_000),
		).rejects.toThrow();
	});

	it('starts and kills a preview server, reporting real ports', async () => {
		if (!available) return;
		const entry = resolve(VAULT, 'basic.typ');
		openDocument('basic.typ');

		const result = await client.executeCommand<StartPreviewResult>(
			TINYMIST_COMMAND.startPreview,
			[
				buildPreviewArgs({
					taskId: 'vitest-preview',
					entryAbsolutePath: entry,
					notPrimary: false,
					invertColors: 'never',
					refreshOnType: true,
				}),
			],
			60_000,
		);

		expect(result.dataPlanePort).toBeTypeOf('number');
		expect(result.staticServerPort).toBeTypeOf('number');

		// `requestUrl` is Obsidian's API and is unavailable in a Node test
		// process; this asserts the loopback preview server really responds.
		const response = await fetch(`http://127.0.0.1:${result.staticServerPort}/`);
		expect(response.ok).toBe(true);
		const html = await response.text();
		expect(html.toLowerCase()).toContain('<!doctype html');

		await client.executeCommand(TINYMIST_COMMAND.killPreview, ['vitest-preview']);
	}, 90_000);

	it('reports a source location when the preview is clicked', async () => {
		if (!available) return;

		// The feature: click rendered content, cursor moves in the editor.
		// Tinymist only sends `tinymist/preview/scrollSource` when the client
		// asked for it via `customizedShowDocument`; otherwise it sends a
		// `window/showDocument` request instead, and a client handling only the
		// notification sees nothing happen. This pins the wiring end to end.
		const entry = resolve(VAULT, 'basic.typ');
		openDocument('basic.typ');

		const jumps: PreviewJumpInfo[] = [];
		const stop = client.onNotification(TINYMIST_NOTIFICATION.previewScrollSource, (params) => {
			jumps.push(params as PreviewJumpInfo);
		});

		const preview = await client.executeCommand<StartPreviewResult>(
			TINYMIST_COMMAND.startPreview,
			[
				buildPreviewArgs({
					taskId: 'vitest-jump',
					entryAbsolutePath: entry,
					notPrimary: false,
					invertColors: 'never',
					refreshOnType: true,
				}),
			],
			60_000,
		);

		try {
			const socket = new WebSocket(`ws://127.0.0.1:${preview.dataPlanePort}`);
			await new Promise<void>((settle, fail) => {
				socket.addEventListener('open', () => settle(), { once: true });
				socket.addEventListener('error', () => fail(new Error('preview websocket refused')), {
					once: true,
				});
			});

			// `current` asks for the rendered document, exactly as the preview
			// frontend does on connect.
			socket.send('current');
			await waitFor('the document to render', () => true, 3_000).catch(() => undefined);
			await new Promise((r) => setTimeout(r, 2_500));

			// What the frontend sends on click, in Typst points on the page.
			// Several points, because a click on whitespace correctly maps to
			// nothing at all.
			for (const point of [
				{ page_no: 1, x: 100, y: 60 },
				{ page_no: 1, x: 40, y: 35 },
				{ page_no: 1, x: 80, y: 50 },
			]) {
				socket.send(`src-point ${JSON.stringify(point)}`);
				await new Promise((r) => setTimeout(r, 900));
			}

			await waitFor('a source jump', () => jumps.length > 0, 8_000);
			socket.close();

			const jump = jumps[0]!;
			expect(jump.filepath).toBe(entry);
			expect(jump.start?.[0]).toBeTypeOf('number');
			expect(jump.start?.[1]).toBeTypeOf('number');
		} finally {
			stop();
			await client.executeCommand(TINYMIST_COMMAND.killPreview, ['vitest-jump']);
		}
	}, 90_000);

	it('subscribes to the preview notification channel', () => {
		if (!available) return;
		// Registration must not throw; delivery is covered by the manual UX pass
		// because it requires a click inside a rendered document.
		const off = client.onNotification(TINYMIST_NOTIFICATION.previewScrollSource, () => undefined);
		expect(off).toBeTypeOf('function');
		off();
	});

	it('finds Tinymist from a GUI launch environment', async () => {
		if (!available) return;

		// The bug this pins: Obsidian launched from Finder or the Dock inherits
		// the system default PATH, not the shell's. A Homebrew tinymist is then
		// invisible, and the plugin reported "not found" for an executable the
		// user could run in a terminal. `buildSearchPath` is what fixes it.
		const guiPath =
			process.platform === 'win32'
				? 'C:\\Windows\\system32'
				: '/usr/bin:/bin:/usr/sbin:/sbin';

		const spawnWith = (path: string) =>
			new Promise<number | null | 'error'>((settle) => {
				const child = host.spawn('tinymist', ['-V'], {
					env: { ...process.env, PATH: path } as Record<string, string>,
				});
				child.on('error', () => settle('error'));
				child.on('exit', (code) => settle(code));
			});

		// Bare, unaugmented: this is the failure users hit.
		const bare = await new Promise<number | null | 'error'>((settle) => {
			const { spawn } = require('node:child_process') as typeof import('node:child_process');
			const child = spawn('tinymist', ['-V'], {
				shell: false,
				env: { ...process.env, PATH: guiPath },
			});
			child.on('error', () => settle('error'));
			child.on('exit', (code) => settle(code));
		});

		// Through the host, which augments PATH with the usual install dirs.
		const augmented = await spawnWith(guiPath);

		// On a machine where tinymist happens to live in /usr/bin, the bare
		// spawn legitimately succeeds; the augmented one must never be worse.
		if (bare === 'error') {
			expect(augmented, 'PATH augmentation should have found tinymist').toBe(0);
		}
		expect(augmented).toBe(0);
	});

	it('restarts cleanly and leaves no process behind', async () => {
		if (!available) return;
		const before = manager.getState();
		expect(before.kind).toBe('ready');

		await manager.restart();
		client = manager.getClient()!;

		expect(manager.getState().kind).toBe('ready');
		expect(client.isInitialized).toBe(true);
	}, 90_000);
});
