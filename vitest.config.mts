import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	resolve: {
		alias: {
			// `obsidian` ships type declarations only, so there is nothing to
			// import at runtime. Units that touch the app get a stand-in; the
			// behaviour that genuinely needs Obsidian is covered by the manual
			// UX pass in docs/testing.md.
			obsidian: fileURLToPath(new URL('./tests/helpers/obsidian-stub.ts', import.meta.url)),
		},
	},
	test: {
		include: ['tests/**/*.test.ts'],
		environment: 'node',
		// Integration tests drive a real Tinymist process: a cold start scans
		// system fonts, which comfortably exceeds the 5s default.
		testTimeout: 90_000,
		hookTimeout: 120_000,
	},
});
