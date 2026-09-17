import { describe, expect, it, vi } from 'vitest';

import { LogSink, Logger } from '../../src/shared/logging';
import { TinymistClient, type ClientTransport } from '../../src/typst/tinymist/client';
import { answerConfiguration } from '../../src/typst/tinymist/manager';
import {
	JSONRPC_VERSION,
	type NotificationMessage,
	type RequestMessage,
	type ResponseMessage,
} from '../../src/typst/tinymist/protocol';

type Sent = RequestMessage | NotificationMessage | ResponseMessage;

/** A transport that records what the client sent and lets tests reply. */
function harness() {
	const sent: Sent[] = [];
	const transport: ClientTransport = { send: (message) => void sent.push(message) };
	const sink = new LogSink();
	sink.setLevel('silent');
	const client = new TinymistClient(transport, new Logger(sink, 'test'));

	return {
		client,
		sent,
		lastRequest: () => sent.filter((m): m is RequestMessage => 'id' in m && 'method' in m).at(-1)!,
		reply: (id: number | string, result: unknown) =>
			client.handleMessage({ jsonrpc: JSONRPC_VERSION, id, result }),
		fail: (id: number | string, message: string) =>
			client.handleMessage({
				jsonrpc: JSONRPC_VERSION,
				id,
				error: { code: -32000, message },
			}),
	};
}

describe('TinymistClient requests', () => {
	it('correlates a response with its request', async () => {
		const h = harness();
		const pending = h.client.request('textDocument/hover', { a: 1 });
		h.reply(h.lastRequest().id, { contents: 'x' });
		await expect(pending).resolves.toEqual({ contents: 'x' });
	});

	it('keeps concurrent requests apart', async () => {
		const h = harness();
		const first = h.client.request('a', null);
		const second = h.client.request('b', null);
		const ids = h.sent.filter((m): m is RequestMessage => 'id' in m && 'method' in m);

		// Reply out of order, which is what a real server does.
		h.reply(ids[1]!.id, 'second');
		h.reply(ids[0]!.id, 'first');

		await expect(first).resolves.toBe('first');
		await expect(second).resolves.toBe('second');
	});

	it('turns a server error into a categorized rejection', async () => {
		const h = harness();
		const pending = h.client.request('bad', null);
		h.fail(h.lastRequest().id, 'no such thing');
		await expect(pending).rejects.toMatchObject({
			code: 'lsp-request-failed',
			message: 'no such thing',
		});
	});

	it('rejects rather than hanging when a response never arrives', async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const pending = h.client.request('slow', null, 1_000);
			const assertion = expect(pending).rejects.toMatchObject({ code: 'lsp-request-failed' });
			await vi.advanceTimersByTimeAsync(1_100);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});

	it('ignores a response for an unknown id', () => {
		const h = harness();
		expect(() => h.reply(999, 'stray')).not.toThrow();
	});
});

describe('TinymistClient notifications', () => {
	it('delivers to every subscriber and stops after unsubscribing', () => {
		const h = harness();
		const seen: unknown[] = [];
		const off = h.client.onNotification('tinymist/compileStatus', (p) => void seen.push(p));
		h.client.onNotification('tinymist/compileStatus', (p) => void seen.push(p));

		h.client.handleMessage({
			jsonrpc: JSONRPC_VERSION,
			method: 'tinymist/compileStatus',
			params: { status: 'compiling' },
		});
		expect(seen).toHaveLength(2);

		off();
		h.client.handleMessage({
			jsonrpc: JSONRPC_VERSION,
			method: 'tinymist/compileStatus',
			params: { status: 'compileSuccess' },
		});
		expect(seen).toHaveLength(3);
	});

	it('keeps running when a handler throws', () => {
		const h = harness();
		const seen: unknown[] = [];
		h.client.onNotification('m', () => {
			throw new Error('handler blew up');
		});
		h.client.onNotification('m', (p) => void seen.push(p));

		expect(() =>
			h.client.handleMessage({ jsonrpc: JSONRPC_VERSION, method: 'm', params: 1 }),
		).not.toThrow();
		expect(seen).toEqual([1]);
	});
});

describe('TinymistClient server requests', () => {
	it('answers a registered server request', async () => {
		const h = harness();
		h.client.onServerRequest('workspace/configuration', () => [{ ok: true }]);
		h.client.handleMessage({
			jsonrpc: JSONRPC_VERSION,
			id: 1,
			method: 'workspace/configuration',
			params: { items: [{ section: 'tinymist' }] },
		});
		await Promise.resolve();
		expect(h.sent.at(-1)).toMatchObject({ id: 1, result: [{ ok: true }] });
	});

	it('replies method-not-found rather than leaving the server waiting', async () => {
		const h = harness();
		h.client.handleMessage({ jsonrpc: JSONRPC_VERSION, id: 2, method: 'unknown/thing' });
		await Promise.resolve();
		expect(h.sent.at(-1)).toMatchObject({ id: 2, error: { code: -32601 } });
	});

	it('reports a throwing handler as an internal error', async () => {
		const h = harness();
		h.client.onServerRequest('x', () => {
			throw new Error('nope');
		});
		h.client.handleMessage({ jsonrpc: JSONRPC_VERSION, id: 3, method: 'x' });
		await Promise.resolve();
		await Promise.resolve();
		expect(h.sent.at(-1)).toMatchObject({ id: 3, error: { code: -32603, message: 'nope' } });
	});
});

describe('TinymistClient capabilities', () => {
	it('reports only what the server advertised', async () => {
		const h = harness();
		const pending = h.client.initialize({ rootPath: null, initializationOptions: {} });
		h.reply(h.lastRequest().id, {
			capabilities: {
				hoverProvider: true,
				completionProvider: {},
				documentFormattingProvider: false,
				executeCommandProvider: { commands: ['tinymist.exportPdf'] },
			},
		});
		await pending;

		expect(h.client.supportsCapability('hoverProvider')).toBe(true);
		expect(h.client.supportsCapability('completionProvider')).toBe(true);
		expect(h.client.supportsCapability('documentFormattingProvider')).toBe(false);
		expect(h.client.supportsCapability('referencesProvider')).toBe(false);

		expect(h.client.supportsCommand('tinymist.exportPdf')).toBe(true);
		expect(h.client.supportsCommand('tinymist.doStartPreview')).toBe(false);
	});

	it('sends no workspace folders when no root is chosen', async () => {
		const h = harness();
		const pending = h.client.initialize({ rootPath: null, initializationOptions: { a: 1 } });
		const params = h.lastRequest().params as Record<string, unknown>;

		expect(params['rootUri']).toBeNull();
		expect(params['workspaceFolders']).toBeNull();
		expect(params['initializationOptions']).toEqual({ a: 1 });

		h.reply(h.lastRequest().id, { capabilities: {} });
		await pending;
	});

	it('sends a file URI root when one is chosen', async () => {
		const h = harness();
		const pending = h.client.initialize({
			rootPath: '/home/me/vault',
			initializationOptions: {},
		});
		const params = h.lastRequest().params as Record<string, unknown>;
		expect(params['rootUri']).toBe('file:///home/me/vault');

		h.reply(h.lastRequest().id, { capabilities: {} });
		await pending;
		expect(h.sent.some((m) => 'method' in m && m.method === 'initialized')).toBe(true);
	});
});

describe('TinymistClient disposal', () => {
	it('fails everything in flight instead of leaving it pending', async () => {
		const h = harness();
		const pending = h.client.request('slow', null);
		h.client.dispose('Tinymist stopped.');
		await expect(pending).rejects.toMatchObject({ message: 'Tinymist stopped.' });
	});

	it('refuses new requests once disposed', async () => {
		const h = harness();
		h.client.dispose('gone');
		await expect(h.client.request('m', null)).rejects.toMatchObject({
			code: 'lsp-request-failed',
		});
	});
});

describe('answerConfiguration', () => {
	it('answers the tinymist section and nulls anything else', () => {
		const config = { exportPdf: 'never' };
		expect(
			answerConfiguration({ items: [{ section: 'tinymist' }, { section: 'editor' }] }, config),
		).toEqual([config, null]);
	});

	it('treats a missing section as the tinymist section', () => {
		const config = { a: 1 };
		expect(answerConfiguration({ items: [{}] }, config)).toEqual([config]);
	});

	it('answers an empty list for malformed params', () => {
		expect(answerConfiguration(undefined, {})).toEqual([]);
	});
});
