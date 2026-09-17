import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import type { DesktopHost, SpawnedProcess } from '../../src/platform/desktop';
import { LogSink, Logger } from '../../src/shared/logging';
import { TinymistProcess } from '../../src/typst/tinymist/process';
import { encodeMessage, JSONRPC_VERSION, type IncomingMessage } from '../../src/typst/tinymist/protocol';

/** A child process the test drives directly. */
class FakeChild extends EventEmitter implements SpawnedProcess {
	readonly pid = 4242;
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly signals: (NodeJS.Signals | undefined)[] = [];
	/** When true, SIGTERM is ignored, as a wedged process would. */
	ignoreSigterm = false;

	kill(signal?: NodeJS.Signals): boolean {
		this.signals.push(signal);
		if (signal === 'SIGTERM' && this.ignoreSigterm) {
			return true;
		}
		queueMicrotask(() => this.emit('exit', 0, signal ?? null));
		return true;
	}

	written(): string {
		return this.stdin.read()?.toString() ?? '';
	}
}

function setup(options: { spawnThrows?: boolean } = {}) {
	const child = new FakeChild();
	const host: DesktopHost = {
		vaultBasePath: '/vault',
		spawn: () => {
			if (options.spawnThrows) {
				throw new Error('ENOENT');
			}
			return child;
		},
		isExecutableFile: async () => true,
		findOnPath: async () => null,
	};

	const sink = new LogSink();
	sink.setLevel('silent');

	const messages: IncomingMessage[] = [];
	const exits: unknown[] = [];

	const process = new TinymistProcess(
		host,
		new Logger(sink, 'test'),
		{ executablePath: '/usr/bin/tinymist', cwd: '/vault' },
		{
			onMessage: (m) => void messages.push(m),
			onExit: (reason) => void exits.push(reason),
		},
	);

	return { child, process, messages, exits };
}

describe('TinymistProcess startup', () => {
	it('reports a spawn failure as a categorized error', () => {
		const { process } = setup({ spawnThrows: true });
		expect(() => process.start()).toThrowError(
			expect.objectContaining({ code: 'tinymist-start-failed' }),
		);
	});

	it('refuses to start twice', () => {
		const { process } = setup();
		process.start();
		expect(() => process.start()).toThrowError(
			expect.objectContaining({ code: 'tinymist-start-failed' }),
		);
	});

	it('runs the lsp subcommand', () => {
		const child = new FakeChild();
		const spawn = vi.fn(() => child);
		const sink = new LogSink();
		sink.setLevel('silent');

		const process = new TinymistProcess(
			{
				vaultBasePath: '/vault',
				spawn,
				isExecutableFile: async () => true,
				findOnPath: async () => null,
			},
			new Logger(sink, 'test'),
			{ executablePath: '/usr/bin/tinymist', cwd: '/vault' },
			{ onMessage: () => undefined, onExit: () => undefined },
		);
		process.start();

		expect(spawn).toHaveBeenCalledWith(
			'/usr/bin/tinymist',
			['lsp'],
			expect.objectContaining({ cwd: '/vault' }),
		);
	});
});

describe('TinymistProcess streams', () => {
	it('decodes messages arriving in fragments', async () => {
		const { child, process, messages } = setup();
		process.start();

		const framed = encodeMessage({ jsonrpc: JSONRPC_VERSION, method: 'ping', params: { a: 1 } });
		child.stdout.write(framed.subarray(0, 8));
		child.stdout.write(framed.subarray(8));
		await new Promise((r) => setImmediate(r));

		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({ method: 'ping' });
	});

	it('retains recent stderr for diagnosing a failure', async () => {
		const { child, process } = setup();
		process.start();
		child.stderr.write('could not find font directory\n');
		await new Promise((r) => setImmediate(r));
		expect(process.recentStderr).toContain('could not find font directory');
	});

	it('refuses to send once the process has gone', async () => {
		const { child, process } = setup();
		process.start();
		child.emit('exit', 1, null);
		await new Promise((r) => setImmediate(r));

		expect(() => process.send({ jsonrpc: JSONRPC_VERSION, method: 'm' })).toThrowError(
			expect.objectContaining({ code: 'lsp-request-failed' }),
		);
	});
});

describe('TinymistProcess shutdown', () => {
	it('reports an unexpected exit as a crash', async () => {
		const { child, process, exits } = setup();
		process.start();
		child.emit('exit', 101, null);
		await new Promise((r) => setImmediate(r));

		expect(exits).toEqual([{ kind: 'crashed', code: 101, signal: null }]);
	});

	it('reports a requested stop as requested, not a crash', async () => {
		const { process, exits } = setup();
		process.start();
		await process.stop();
		expect(exits).toEqual([{ kind: 'requested' }]);
	});

	it('runs the handshake before signalling', async () => {
		const { process } = setup();
		process.start();
		const order: string[] = [];
		await process.stop(async () => {
			order.push('handshake');
		});
		order.push('stopped');
		expect(order).toEqual(['handshake', 'stopped']);
	});

	it('still terminates when the handshake fails', async () => {
		const { child, process } = setup();
		process.start();
		await process.stop(async () => {
			throw new Error('pipe already closed');
		});
		expect(child.signals).toContain('SIGTERM');
	});

	it('escalates to SIGKILL when SIGTERM is ignored', async () => {
		const { child, process } = setup();
		child.ignoreSigterm = true;
		process.start();

		await process.stop();

		expect(child.signals).toContain('SIGTERM');
		expect(child.signals).toContain('SIGKILL');
	}, 20_000);

	it('kills outright with no handshake for plugin unload', () => {
		const { child, process } = setup();
		process.start();
		process.killNow();
		expect(child.signals).toEqual(['SIGKILL']);
		expect(process.isRunning).toBe(false);
	});

	it('is safe to stop when it was never started', async () => {
		const { process } = setup();
		await expect(process.stop()).resolves.toBeUndefined();
		expect(() => process.killNow()).not.toThrow();
	});

	it('reports a crash only once', async () => {
		const { child, process, exits } = setup();
		process.start();
		child.emit('exit', 1, null);
		child.emit('exit', 1, null);
		await new Promise((r) => setImmediate(r));
		expect(exits).toHaveLength(1);
	});
});
