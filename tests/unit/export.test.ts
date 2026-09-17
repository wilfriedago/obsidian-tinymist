import { describe, expect, it } from 'vitest';

import { decodeBase64 } from '../../src/typst/compiler/export';

/**
 * `decodeBase64` turns the base64 Tinymist returns into the `ArrayBuffer` the
 * Vault binary APIs take. The subtlety worth pinning is that Node allocates
 * small buffers out of a shared pool, so `Buffer.buffer` is usually a much
 * larger backing store at a non-zero offset. Returning it directly would hand
 * the vault the whole pool — other buffers' contents included.
 */
describe('decodeBase64', () => {
	it('round-trips bytes exactly', () => {
		const original = Uint8Array.from([0, 1, 2, 250, 251, 255]);
		const decoded = new Uint8Array(decodeBase64(Buffer.from(original).toString('base64')));
		expect([...decoded]).toEqual([...original]);
	});

	it('returns a buffer of exactly the decoded length, not the pool', () => {
		// Small inputs come from Node's internal pool, so this is the case that
		// would silently leak unrelated memory if the offset were ignored.
		const source = Buffer.from('hello typst', 'utf8');
		const pooled = Buffer.from(source.toString('base64'), 'base64');
		expect(pooled.byteLength).toBeLessThan(pooled.buffer.byteLength);

		const decoded = decodeBase64(source.toString('base64'));
		expect(decoded.byteLength).toBe(source.byteLength);
		expect(Buffer.from(decoded).toString('utf8')).toBe('hello typst');
	});

	it('handles an empty payload', () => {
		expect(decodeBase64('').byteLength).toBe(0);
	});

	it('preserves a PDF header, which is what export actually carries', () => {
		const pdf = Buffer.concat([
			Buffer.from('%PDF-1.7\n', 'latin1'),
			Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3]),
		]);
		const decoded = Buffer.from(decodeBase64(pdf.toString('base64')));
		expect(decoded.subarray(0, 5).toString('latin1')).toBe('%PDF-');
		expect(decoded.equals(pdf)).toBe(true);
	});

	it('is not confused by a large payload spanning many pool allocations', () => {
		const large = Buffer.alloc(64 * 1024, 7);
		const decoded = Buffer.from(decodeBase64(large.toString('base64')));
		expect(decoded.byteLength).toBe(large.byteLength);
		expect(decoded.equals(large)).toBe(true);
	});
});
