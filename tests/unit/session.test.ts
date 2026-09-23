import { describe, expect, it } from 'vitest';

import { LogSink, Logger } from '../../src/shared/logging';
import { DocumentSession, languageIdFor } from '../../src/typst/documents/session';
import { TinymistClient, type ClientTransport } from '../../src/typst/tinymist/client';
import { JSONRPC_VERSION, type NotificationMessage } from '../../src/typst/tinymist/protocol';

function setup() {
	const sent: NotificationMessage[] = [];
	const transport: ClientTransport = {
		send: (message) => {
			if (!('id' in message)) {
				sent.push(message as NotificationMessage);
			}
		},
	};
	const sink = new LogSink();
	sink.setLevel('silent');

	const client = new TinymistClient(transport, new Logger(sink, 'test'));
	const session = new DocumentSession('/home/me/vault', new Logger(sink, 'test'));
	session.attach(client);

	return {
		session,
		client,
		sent,
		methods: () => sent.map((m) => m.method),
		last: () => sent.at(-1),
	};
}

describe('DocumentSession identity', () => {
	it('builds a file URI from the vault path', () => {
		const { session } = setup();
		expect(session.uriFor('papers/main.typ')).toBe('file:///home/me/vault/papers/main.typ');
		expect(session.absolutePathFor('papers/main.typ')).toBe('/home/me/vault/papers/main.typ');
	});

	it('keeps documents with the same basename apart', () => {
		const { session } = setup();
		session.open('a/main.typ', 'A');
		session.open('b/main.typ', 'B');
		expect(session.openCount).toBe(2);
		expect(session.isOpen('a/main.typ')).toBe(true);
	});
});

describe('DocumentSession synchronization', () => {
	it('announces an opened document once', () => {
		const { session, methods } = setup();
		session.open('a.typ', 'text');
		expect(methods()).toEqual(['textDocument/didOpen']);
	});

	it('increments the version on each change', () => {
		const { session, sent } = setup();
		session.open('a.typ', 'one');
		session.change('a.typ', 'two');
		session.change('a.typ', 'three');

		const versions = sent.map(
			(m) => (m.params as { textDocument: { version: number } }).textDocument.version,
		);
		expect(versions).toEqual([1, 2, 3]);
	});

	it('sends nothing when the text has not actually changed', () => {
		const { session, methods } = setup();
		session.open('a.typ', 'same');
		session.change('a.typ', 'same');
		expect(methods()).toEqual(['textDocument/didOpen']);
	});

	it('opens a document that is changed before it was opened', () => {
		const { session, methods } = setup();
		session.change('a.typ', 'text');
		expect(methods()).toEqual(['textDocument/didOpen']);
	});

	it('closes a document and forgets it', () => {
		const { session, methods } = setup();
		session.open('a.typ', 'text');
		session.close('a.typ');
		expect(methods()).toEqual(['textDocument/didOpen', 'textDocument/didClose']);
		expect(session.isOpen('a.typ')).toBe(false);
	});

	it('ignores closing a document that was never open', () => {
		const { session, methods } = setup();
		session.close('ghost.typ');
		expect(methods()).toEqual([]);
	});

	it('re-announces a rename under the new path', () => {
		const { session, sent } = setup();
		session.open('old.typ', 'body');
		sent.length = 0;

		session.rename('old.typ', 'new/renamed.typ');

		expect(sent.map((m) => m.method)).toEqual([
			'textDocument/didClose',
			'textDocument/didOpen',
		]);
		const opened = sent[1]?.params as { textDocument: { uri: string; text: string } };
		expect(opened.textDocument.uri).toBe('file:///home/me/vault/new/renamed.typ');
		expect(opened.textDocument.text).toBe('body');
		expect(session.isOpen('new/renamed.typ')).toBe(true);
	});
});

describe('DocumentSession across a restart', () => {
	it('replays open documents with the buffer text, not the text on disk', () => {
		// After a crash the user's unsaved edits only exist in the editor; the
		// session has to hand them back rather than let Tinymist re-read disk.
		const { session, sent } = setup();
		session.open('a.typ', 'saved');
		session.change('a.typ', 'unsaved edit');
		sent.length = 0;

		const sink = new LogSink();
		sink.setLevel('silent');
		const replayed: NotificationMessage[] = [];
		const fresh = new TinymistClient(
			{ send: (m) => void (!('id' in m) && replayed.push(m as NotificationMessage)) },
			new Logger(sink, 'test'),
		);

		session.detach();
		session.attach(fresh);

		expect(replayed).toHaveLength(1);
		const params = replayed[0]?.params as { textDocument: { text: string; version: number } };
		expect(params.textDocument.text).toBe('unsaved edit');
		expect(params.textDocument.version).toBe(3);
	});

	it('drops notifications while detached rather than throwing', () => {
		const { session } = setup();
		session.open('a.typ', 'x');
		session.detach();
		expect(() => session.change('a.typ', 'y')).not.toThrow();
		expect(() => session.close('a.typ')).not.toThrow();
	});

	it('reports a missing client when one is required', () => {
		const { session } = setup();
		session.detach();
		expect(() => session.requireClient()).toThrowError(
			expect.objectContaining({ code: 'document-sync-failed' }),
		);
	});

	it('closes everything on unload', () => {
		const { session, sent } = setup();
		session.open('a.typ', '1');
		session.open('b.typ', '2');
		sent.length = 0;
		session.closeAll();
		expect(sent.map((m) => m.method)).toEqual([
			'textDocument/didClose',
			'textDocument/didClose',
		]);
		expect(session.openCount).toBe(0);
	});
});

describe('DocumentSession save', () => {
	it('notifies a save for an open document only', () => {
		const { session, methods } = setup();
		session.open('a.typ', 'x');
		session.save('a.typ');
		session.save('ghost.typ');
		expect(methods()).toEqual(['textDocument/didOpen', 'textDocument/didSave']);
	});
});

describe('notification shape', () => {
	it('uses the LSP jsonrpc envelope', () => {
		const { session, last } = setup();
		session.open('a.typ', 'x');
		expect(last()?.jsonrpc).toBe(JSONRPC_VERSION);
	});
});

describe('bibliographies', () => {
	it('announces a bibliography as BibTeX and a document as Typst', () => {
		const { session, sent } = setup();
		session.open('paper/main.typ', '= Hi');
		session.open('paper/refs.bib', '@book{k, title = {T}}');
		const languages = sent.map(
			(m) => (m.params as { textDocument: { languageId: string } }).textDocument.languageId,
		);
		expect(languages).toEqual(['typst', 'bibtex']);
	});

	it('matches the extension case-insensitively', () => {
		expect(languageIdFor('Refs.BIB')).toBe('bibtex');
		expect(languageIdFor('main.typ')).toBe('typst');
	});

	it('announces a Hayagriva file as YAML, under either extension', () => {
		expect(languageIdFor('refs.yml')).toBe('yaml');
		expect(languageIdFor('refs.yaml')).toBe('yaml');
	});

	it('replays an open bibliography after a restart', () => {
		const { session, client, methods } = setup();
		session.open('paper/refs.bib', 'unsaved entry');
		session.detach();
		session.attach(client);
		expect(methods()).toEqual(['textDocument/didOpen', 'textDocument/didOpen']);
	});
});
