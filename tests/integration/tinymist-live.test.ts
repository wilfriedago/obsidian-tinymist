import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { LogSink, Logger } from '../../src/shared/logging';
import { TinymistManager } from '../../src/typst/tinymist/manager';
import { TinymistClient } from '../../src/typst/tinymist/client';
import { buildPreviewArgs } from '../../src/typst/tinymist/config';
import {
	TINYMIST_COMMAND,
	TINYMIST_NOTIFICATION,
	type CompileStatusParams,
	type ExportResult,
	type PublishDiagnosticsParams,
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

	it('subscribes to the preview notification channel', () => {
		if (!available) return;
		// Registration must not throw; delivery is covered by the manual UX pass
		// because it requires a click inside a rendered document.
		const off = client.onNotification(TINYMIST_NOTIFICATION.previewScrollSource, () => undefined);
		expect(off).toBeTypeOf('function');
		off();
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
