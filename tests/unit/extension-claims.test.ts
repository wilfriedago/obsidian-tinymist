import type { App, Plugin } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

import { TypstRuntime } from '../../src/plugin/runtime';

/**
 * A bibliography is a secondary feature, and another plugin may already open
 * `.bib` files. Obsidian throws on a second claim; that must cost this plugin
 * the `.bib` editor, not its whole load.
 */
describe('claiming a contested extension', () => {
	function runtimeWith(registerExtensions: (extensions: string[], viewType: string) => void) {
		const plugin = { registerExtensions } as unknown as Plugin;
		const runtime = new TypstRuntime({} as App, plugin);
		const claim = (extension: string) =>
			(runtime as unknown as { claimExtension(e: string, v: string): void }).claimExtension(
				extension,
				'typst-bibliography',
			);
		return { runtime, claim };
	}

	it('owns the extension when the claim succeeds', () => {
		const register = vi.fn();
		const { runtime, claim } = runtimeWith(register);
		claim('bib');
		expect(register).toHaveBeenCalledWith(['bib'], 'typst-bibliography');
		expect(runtime.ownsExtension('bib')).toBe(true);
	});

	it('survives another plugin having it first', () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const { runtime, claim } = runtimeWith(() => {
			throw new Error('Attempting to register an existing file extension');
		});
		expect(() => claim('bib')).not.toThrow();
		expect(runtime.ownsExtension('bib')).toBe(false);
	});
});
