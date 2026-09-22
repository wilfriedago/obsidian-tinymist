import { describe, expect, it } from 'vitest';

import { LogSink, Logger } from '../../src/shared/logging';
import { PreviewController, taskIdFor } from '../../src/preview/preview-controller';
import { shouldRetargetPreview } from '../../src/preview/typst-preview-view';
import { presentStatus } from '../../src/plugin/status-bar';
import { hoverText, stripSnippetPlaceholders } from '../../src/editor/language-features';
import { TinymistClient, type ClientTransport } from '../../src/typst/tinymist/client';
import { JSONRPC_VERSION, TINYMIST_COMMAND, type RequestMessage } from '../../src/typst/tinymist/protocol';

/** A client that answers `executeCommand` from a scripted table. */
function scriptedClient(
	responses: Record<string, unknown>,
	commands: string[] = Object.values(TINYMIST_COMMAND),
) {
	const requests: RequestMessage[] = [];
	const transport: ClientTransport = {
		send: (message) => {
			if (!('id' in message) || !('method' in message)) {
				return;
			}
			const request = message as RequestMessage;
			requests.push(request);
			const command = (request.params as { command: string }).command;
			queueMicrotask(() =>
				client.handleMessage({
					jsonrpc: JSONRPC_VERSION,
					id: request.id,
					result: responses[command] ?? null,
				}),
			);
		},
	};
	const sink = new LogSink();
	sink.setLevel('silent');
	const client = new TinymistClient(transport, new Logger(sink, 'test'));
	// Pretend the initialize handshake advertised these commands.
	(client as unknown as { capabilities: unknown }).capabilities = {
		executeCommandProvider: { commands },
	};
	return { client, requests };
}

function isCommand(request: RequestMessage, command: string): boolean {
	return (request.params as { command?: string } | undefined)?.command === command;
}

function controller() {
	const sink = new LogSink();
	sink.setLevel('silent');
	return new PreviewController(new Logger(sink, 'preview'));
}

describe('taskIdFor', () => {
	it('is stable for the same path', () => {
		expect(taskIdFor('papers/main.typ')).toBe(taskIdFor('papers/main.typ'));
	});

	it('distinguishes identical basenames in different folders', () => {
		expect(taskIdFor('a/main.typ')).not.toBe(taskIdFor('b/main.typ'));
	});

	it('is safe to pass as a CLI argument', () => {
		const id = taskIdFor('papers/a b/résumé.typ');
		expect(id).toMatch(/^obsidian-[0-9a-f]{8}$/);
	});

	it('never collides with the reserved id', () => {
		expect(taskIdFor('primary')).not.toBe('primary');
	});
});

describe('PreviewController', () => {
	const startResult = { dataPlanePort: 51285, staticServerPort: 51285, isPrimary: true };

	it('starts a task and exposes a loopback URL', async () => {
		const { client } = scriptedClient({ [TINYMIST_COMMAND.startPreview]: startResult });
		const session = await controller().start(client, 'a.typ', '/v/a.typ', {
			refreshOnType: true,
			partialRendering: true,
			invertColors: 'never' as const,
		});
		expect(session.url).toBe('http://127.0.0.1:51285/');
		expect(session.isPrimary).toBe(true);
	});

	it('reuses a running task instead of starting a second one', async () => {
		const { client, requests } = scriptedClient({
			[TINYMIST_COMMAND.startPreview]: startResult,
		});
		const c = controller();
		const first = await c.start(client, 'a.typ', '/v/a.typ', {
			refreshOnType: true,
			partialRendering: true,
			invertColors: 'never' as const,
		});
		const second = await c.start(client, 'a.typ', '/v/a.typ', {
			refreshOnType: true,
			partialRendering: true,
			invertColors: 'never' as const,
		});
		expect(second).toBe(first);
		expect(requests).toHaveLength(1);
	});

	it('collapses concurrent starts of the same document into one task', async () => {
		const { client, requests } = scriptedClient({
			[TINYMIST_COMMAND.startPreview]: startResult,
		});
		const c = controller();
		const [a, b] = await Promise.all([
			c.start(client, 'a.typ', '/v/a.typ', { refreshOnType: true, partialRendering: true, invertColors: 'never' as const }),
			c.start(client, 'a.typ', '/v/a.typ', { refreshOnType: true, partialRendering: true, invertColors: 'never' as const }),
		]);
		expect(a).toBe(b);
		expect(requests).toHaveLength(1);
	});

	it('marks the second document as not primary', async () => {
		const { client, requests } = scriptedClient({
			[TINYMIST_COMMAND.startPreview]: startResult,
		});
		const c = controller();
		await c.start(client, 'a.typ', '/v/a.typ', { refreshOnType: true, partialRendering: true, invertColors: 'never' as const });
		await c.start(client, 'b.typ', '/v/b.typ', { refreshOnType: true, partialRendering: true, invertColors: 'never' as const });

		const second = requests[1] as RequestMessage;
		const [args] = (second.params as { arguments: string[][] }).arguments;
		expect(args).toContain('--not-primary');
	});

	it('reports a missing port rather than building a broken URL', async () => {
		const { client } = scriptedClient({ [TINYMIST_COMMAND.startPreview]: { isPrimary: true } });
		await expect(
			controller().start(client, 'a.typ', '/v/a.typ', {
				refreshOnType: true,
				partialRendering: true,
				invertColors: 'never' as const,
			}),
		).rejects.toMatchObject({ code: 'preview-unavailable' });
	});

	it('refuses when the server does not advertise the preview command', async () => {
		const { client } = scriptedClient({}, ['tinymist.exportPdf']);
		await expect(
			controller().start(client, 'a.typ', '/v/a.typ', {
				refreshOnType: true,
				partialRendering: true,
				invertColors: 'never' as const,
			}),
		).rejects.toMatchObject({ code: 'preview-unavailable' });
	});

	it('kills the task on stop and forgets it', async () => {
		const { client, requests } = scriptedClient({
			[TINYMIST_COMMAND.startPreview]: startResult,
		});
		const c = controller();
		await c.start(client, 'a.typ', '/v/a.typ', { refreshOnType: true, partialRendering: true, invertColors: 'never' as const });
		await c.stop(client, 'a.typ');

		expect(requests.at(-1)?.params).toMatchObject({ command: TINYMIST_COMMAND.killPreview });
		expect(c.getSession('a.typ')).toBeNull();
		expect(c.activeCount).toBe(0);
	});

	it('forgets a task the server says is gone', async () => {
		const { client } = scriptedClient({ [TINYMIST_COMMAND.startPreview]: startResult });
		const c = controller();
		const session = await c.start(client, 'a.typ', '/v/a.typ', {
			refreshOnType: true,
			partialRendering: true,
			invertColors: 'never' as const,
		});
		expect(c.vaultPathForTask(session.taskId)).toBe('a.typ');
		c.forgetTask(session.taskId);
		expect(c.getSession('a.typ')).toBeNull();
	});

	it('does not scroll a document that has no preview', async () => {
		const { client, requests } = scriptedClient({});
		await controller().scrollToSource(client, 'a.typ', '/v/a.typ', 3, 4);
		expect(requests).toHaveLength(0);
	});

	it('sends the cursor position for a document that has one', async () => {
		const { client, requests } = scriptedClient({
			[TINYMIST_COMMAND.startPreview]: startResult,
		});
		const c = controller();
		await c.start(client, 'a.typ', '/v/a.typ', { refreshOnType: true, partialRendering: true, invertColors: 'never' as const });
		await c.scrollToSource(client, 'a.typ', '/v/a.typ', 3, 4);

		expect(requests.at(-1)?.params).toMatchObject({
			command: TINYMIST_COMMAND.scrollPreview,
			arguments: [
				expect.any(String),
				{ event: 'panelScrollTo', filepath: '/v/a.typ', line: 3, character: 4 },
			],
		});
	});

	it('restarts the task when the theme changes, and not otherwise', async () => {
		const { client, requests } = scriptedClient({
			[TINYMIST_COMMAND.startPreview]: startResult,
		});
		const c = controller();

		const light = await c.start(client, 'a.typ', '/v/a.typ', {
			refreshOnType: true,
			partialRendering: true,
			invertColors: 'never',
		});
		expect(light.invertColors).toBe('never');

		// Same strategy: the running task is reused.
		await c.start(client, 'a.typ', '/v/a.typ', { refreshOnType: true, partialRendering: true, invertColors: 'never' });
		expect(requests.filter((r) => isCommand(r, TINYMIST_COMMAND.startPreview))).toHaveLength(1);

		// Different strategy: colour inversion is fixed at task start, so the
		// old task has to be killed and a new one started.
		const dark = await c.start(client, 'a.typ', '/v/a.typ', {
			refreshOnType: true,
			partialRendering: true,
			invertColors: 'always',
		});
		expect(dark.invertColors).toBe('always');
		expect(requests.filter((r) => isCommand(r, TINYMIST_COMMAND.startPreview))).toHaveLength(2);
		expect(requests.filter((r) => isCommand(r, TINYMIST_COMMAND.killPreview))).toHaveLength(1);

		const last = requests.at(-1) as RequestMessage;
		const [restartArgs] = (last.params as { arguments: string[][] }).arguments;
		expect((restartArgs ?? []).join(' ')).toContain('--invert-colors always');
	});

	it('tolerates stopping with no client, as after a crash', async () => {
		const { client } = scriptedClient({ [TINYMIST_COMMAND.startPreview]: startResult });
		const c = controller();
		await c.start(client, 'a.typ', '/v/a.typ', { refreshOnType: true, partialRendering: true, invertColors: 'never' as const });
		await expect(c.stop(null, 'a.typ')).resolves.toBeUndefined();
		expect(c.activeCount).toBe(0);
	});
});

describe('presentStatus', () => {
	const clean = { errors: 0, warnings: 0, total: 0 };

	it('shows the server state before anything else', () => {
		expect(
			presentStatus({
				serverState: 'crashed',
				compilePhase: 'success',
				diagnostics: clean,
				hasActiveDocument: true,
			}),
		).toMatchObject({ text: 'Typst: disconnected', modifier: 'error' });
	});

	it('shows compiling while a compile is in flight', () => {
		expect(
			presentStatus({
				serverState: 'ready',
				compilePhase: 'compiling',
				diagnostics: clean,
				hasActiveDocument: true,
			}),
		).toMatchObject({ text: 'Typst: compiling', modifier: 'busy' });
	});

	it('counts errors and warnings in words', () => {
		expect(
			presentStatus({
				serverState: 'ready',
				compilePhase: 'error',
				diagnostics: { errors: 1, warnings: 2, total: 3 },
				hasActiveDocument: true,
			}).text,
		).toBe('Typst: 1 error, 2 warnings');
	});

	it('says ready when the document is clean', () => {
		expect(
			presentStatus({
				serverState: 'ready',
				compilePhase: 'success',
				diagnostics: clean,
				hasActiveDocument: true,
			}),
		).toMatchObject({ text: 'Typst: ready', modifier: 'ok' });
	});
});

describe('snippet and hover conversion', () => {
	it('renders snippet placeholders as plain text', () => {
		expect(stripSnippetPlaceholders('figure(${1:body})$0')).toBe('figure(body)');
		expect(stripSnippetPlaceholders('text(${1|a,b|})')).toBe('text(a)');
		expect(stripSnippetPlaceholders('cost: \\$5')).toBe('cost: $5');
	});

	it('flattens the several shapes hover contents can take', () => {
		expect(hoverText({ contents: 'plain' })).toBe('plain');
		expect(hoverText({ contents: { kind: 'markdown', value: 'md' } })).toBe('md');
		expect(hoverText({ contents: ['a', { kind: 'markdown', value: 'b' }] })).toBe('a\nb');
		expect(hoverText(null)).toBe('');
	});
});

describe('shouldRetargetPreview', () => {
	const following = { vaultPath: 'a.typ', pinned: false };

	it('re-points a following preview at the document being edited', () => {
		expect(shouldRetargetPreview(following, 'b.typ', false)).toBe(true);
	});

	it('leaves a pinned preview alone', () => {
		expect(shouldRetargetPreview({ vaultPath: 'a.typ', pinned: true }, 'b.typ', false)).toBe(
			false,
		);
	});

	it('does nothing when the preview already shows that document', () => {
		expect(shouldRetargetPreview(following, 'a.typ', false)).toBe(false);
	});

	it('fills an idle preview rather than leaving it empty', () => {
		expect(shouldRetargetPreview({ vaultPath: null, pinned: false }, 'a.typ', false)).toBe(true);
	});

	// A leaf restored from a workspace saved before pinning existed, and one
	// Obsidian has deferred, both arrive without a stored choice.
	it('falls back to the setting when the leaf has no stored choice', () => {
		expect(shouldRetargetPreview({ vaultPath: 'a.typ' }, 'b.typ', false)).toBe(true);
		expect(shouldRetargetPreview({ vaultPath: 'a.typ' }, 'b.typ', true)).toBe(false);
		expect(shouldRetargetPreview(undefined, 'b.typ', false)).toBe(true);
		expect(shouldRetargetPreview(undefined, 'b.typ', true)).toBe(false);
	});
});
