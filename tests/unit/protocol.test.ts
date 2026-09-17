import { describe, expect, it } from 'vitest';

import {
	MessageDecoder,
	encodeMessage,
	isNotification,
	isRequest,
	isResponse,
	JSONRPC_VERSION,
} from '../../src/typst/tinymist/protocol';

describe('encodeMessage', () => {
	it('frames with a byte length, not a character count', () => {
		const framed = encodeMessage({
			jsonrpc: JSONRPC_VERSION,
			method: 'test',
			params: { text: 'héllo → 𝕏' },
		});
		const header = framed.subarray(0, framed.indexOf('\r\n\r\n')).toString('ascii');
		const declared = Number(/Content-Length: (\d+)/.exec(header)?.[1]);
		const body = framed.subarray(framed.indexOf('\r\n\r\n') + 4);

		expect(declared).toBe(body.byteLength);
		expect(declared).toBeGreaterThan(JSON.stringify({ text: 'héllo → 𝕏' }).length);
	});
});

describe('MessageDecoder', () => {
	const message = (id: number) =>
		encodeMessage({ jsonrpc: JSONRPC_VERSION, id, method: 'm', params: { id } });

	it('decodes a whole message', () => {
		const decoder = new MessageDecoder();
		const [decoded] = decoder.append(message(1));
		expect(decoded).toMatchObject({ id: 1, method: 'm' });
		expect(decoder.pendingBytes).toBe(0);
	});

	it('reassembles a message split across chunks', () => {
		const decoder = new MessageDecoder();
		const framed = message(7);
		const split = Math.floor(framed.byteLength / 2);

		expect(decoder.append(framed.subarray(0, split))).toHaveLength(0);
		const [decoded] = decoder.append(framed.subarray(split));
		expect(decoded).toMatchObject({ id: 7 });
	});

	it('splits a chunk carrying several messages', () => {
		const decoder = new MessageDecoder();
		const decoded = decoder.append(Buffer.concat([message(1), message(2), message(3)]));
		expect(decoded.map((m) => (m as { id: number }).id)).toEqual([1, 2, 3]);
	});

	it('handles a message split mid-header', () => {
		const decoder = new MessageDecoder();
		const framed = message(9);
		expect(decoder.append(framed.subarray(0, 6))).toHaveLength(0);
		const [decoded] = decoder.append(framed.subarray(6));
		expect(decoded).toMatchObject({ id: 9 });
	});

	it('does not split a multi-byte character across a chunk boundary', () => {
		const decoder = new MessageDecoder();
		const framed = encodeMessage({
			jsonrpc: JSONRPC_VERSION,
			id: 1,
			method: 'm',
			params: { text: '→→→→' },
		});
		// Cut inside the UTF-8 encoding of a character.
		const cut = framed.byteLength - 5;
		decoder.append(framed.subarray(0, cut));
		const [decoded] = decoder.append(framed.subarray(cut));
		expect((decoded as { params: { text: string } }).params.text).toBe('→→→→');
	});

	it('resynchronizes after a header with no content length', () => {
		const decoder = new MessageDecoder();
		const decoded = decoder.append(
			Buffer.concat([Buffer.from('X-Nonsense: 1\r\n\r\n', 'ascii'), message(4)]),
		);
		expect(decoded.map((m) => (m as { id: number }).id)).toEqual([4]);
	});

	it('skips a malformed body without losing the stream', () => {
		const decoder = new MessageDecoder();
		const bad = Buffer.from('Content-Length: 3\r\n\r\n{[}', 'ascii');
		const decoded = decoder.append(Buffer.concat([bad, message(5)]));
		expect(decoded.map((m) => (m as { id: number }).id)).toEqual([5]);
	});

	it('is case-insensitive about the header name', () => {
		const decoder = new MessageDecoder();
		const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'm' }), 'utf8');
		const framed = Buffer.concat([
			Buffer.from(`content-length: ${body.byteLength}\r\n\r\n`, 'ascii'),
			body,
		]);
		expect(decoder.append(framed)).toHaveLength(1);
	});

	it('forgets buffered bytes on reset', () => {
		const decoder = new MessageDecoder();
		decoder.append(message(1).subarray(0, 10));
		expect(decoder.pendingBytes).toBeGreaterThan(0);
		decoder.reset();
		expect(decoder.pendingBytes).toBe(0);
	});
});

describe('message discrimination', () => {
	it('tells responses, requests, and notifications apart', () => {
		expect(isResponse({ jsonrpc: JSONRPC_VERSION, id: 1, result: null })).toBe(true);
		expect(isRequest({ jsonrpc: JSONRPC_VERSION, id: 1, method: 'm' })).toBe(true);
		expect(isNotification({ jsonrpc: JSONRPC_VERSION, method: 'm' })).toBe(true);

		expect(isResponse({ jsonrpc: JSONRPC_VERSION, id: 1, method: 'm' })).toBe(false);
		expect(isNotification({ jsonrpc: JSONRPC_VERSION, id: 1, method: 'm' })).toBe(false);
	});
});
