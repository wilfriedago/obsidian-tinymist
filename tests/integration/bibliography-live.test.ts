import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { LogSink, Logger } from '../../src/shared/logging';
import { absolutePathToFileUri } from '../../src/shared/paths';
import { DocumentSession } from '../../src/typst/documents/session';
import { TinymistManager } from '../../src/typst/tinymist/manager';
import {
	TINYMIST_NOTIFICATION,
	type CompileStatusParams,
	type PublishDiagnosticsParams,
} from '../../src/typst/tinymist/protocol';
import { NodeTestHost } from '../helpers/node-host';

/**
 * Why the bibliography editor announces its buffer to Tinymist at all.
 *
 * Tinymist does not notice a `.bib` changing on disk: with this client it
 * neither watches the file nor re-reads it when the citing document changes.
 * What it does honour is the bibliography being open as a document, which is
 * what these tests pin down. Everything happens in memory; nothing is written
 * to the test vault.
 */

const VAULT = resolve(__dirname, '../../test-vault');
const MAIN = 'project/main.typ';
const BIB = 'project/bibliography.bib';
const host = new NodeTestHost(VAULT);

let available = false;
let manager: TinymistManager;
let session: DocumentSession;
const statuses: CompileStatusParams[] = [];
const diagnosticsByUri = new Map<string, PublishDiagnosticsParams>();

const onDisk = (relative: string) => readFileSync(resolve(VAULT, relative), 'utf8');
const citingNewKey = onDisk(MAIN).replace('@knuth1984', '@knuth1984 @unsaved2026');
const withNewKey = `${onDisk(BIB)}\n@misc{unsaved2026,\n  title = {Unsaved},\n  author = {Someone},\n  year = {2026}\n}\n`;

/** Resolves with the next compile outcome after `action`, or `null` on timeout. */
async function nextOutcome(action: () => void, timeoutMs = 25_000): Promise<string | null> {
	const from = statuses.length;
	action();
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const outcome = statuses.slice(from).find((status) => status.status !== 'compiling');
		if (outcome) {
			return outcome.status;
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	return null;
}

async function tinymistIsAvailable(): Promise<boolean> {
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
	session = new DocumentSession(VAULT, new Logger(sink, 'session'));
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
			exportStagingDirectory: '',
		}),
		onClientReady: (ready) => {
			ready.onNotification('textDocument/publishDiagnostics', (params) => {
				const typed = params as PublishDiagnosticsParams;
				diagnosticsByUri.set(typed.uri, typed);
			});
			ready.onNotification(TINYMIST_NOTIFICATION.compileStatus, (params) => {
				statuses.push(params as CompileStatusParams);
			});
		},
		onClientGone: () => undefined,
	});
	session.attach(await manager.ensureStarted());
}, 90_000);

afterAll(async () => {
	if (available && manager) {
		session.closeAll();
		await manager.stop();
	}
});

describe.runIf(process.env['SKIP_TINYMIST_TESTS'] !== '1')('bibliographies, live', () => {
	it('fails to compile while the cited key exists only in an unopened bibliography', async () => {
		if (!available) return;
		expect(await nextOutcome(() => session.open(MAIN, citingNewKey))).toBe('compileError');
	});

	it('compiles against an unsaved bibliography buffer', async () => {
		if (!available) return;
		expect(await nextOutcome(() => session.open(BIB, withNewKey))).toBe('compileSuccess');
	});

	it('reports a bibliography parse error on the bibliography itself', async () => {
		if (!available) return;
		const bibUri = absolutePathToFileUri(resolve(VAULT, BIB));
		expect(await nextOutcome(() => session.change(BIB, '@book{broken,\n  title = {Unclosed\n'))).toBe(
			'compileError',
		);
		const deadline = Date.now() + 10_000;
		while (!diagnosticsByUri.get(bibUri)?.diagnostics.length && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 100));
		}
		expect(diagnosticsByUri.get(bibUri)?.diagnostics[0]?.message).toMatch(/BibLaTeX/);
	});

	it('falls back to the file on disk once the bibliography is closed', async () => {
		if (!available) return;
		// On disk the new key does not exist, so the citing document fails again.
		expect(await nextOutcome(() => session.change(BIB, withNewKey))).toBe('compileSuccess');
		expect(await nextOutcome(() => session.close(BIB))).toBe('compileError');
	});

	it('compiles against an unsaved Hayagriva buffer the same way', async () => {
		if (!available) return;
		const main = 'hayagriva/main.typ';
		const yml = 'hayagriva/references.yml';
		const citing = onDisk(main).replace('@knuth1984', '@knuth1984 @unsaved2026');
		expect(await nextOutcome(() => session.open(main, citing))).toBe('compileError');
		const extended = `${onDisk(yml)}unsaved2026:\n  type: misc\n  title: Unsaved\n  date: 2026\n`;
		expect(await nextOutcome(() => session.open(yml, extended))).toBe('compileSuccess');
		session.close(yml);
		session.close(main);
	});
});
