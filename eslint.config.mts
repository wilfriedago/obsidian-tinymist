import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { globalIgnores, defineConfig } from 'eslint/config';

/**
 * The six Obsidian review rules that need type information.
 *
 * Day-to-day linting is oxlint (`pnpm lint`), which runs the other 23
 * `eslint-plugin-obsidianmd` rules through its `jsPlugins` support. Those six
 * call `getParserServices()`, and oxlint's JS plugin host deliberately does not
 * provide type information, so they are the only reason ESLint is still here.
 *
 * Directory approval is a hard requirement for this project, so the checks are
 * worth the second tool. Run with `pnpm lint:obsidian`; CI runs both.
 *
 * If oxlint gains type-aware JS plugins, this file and the `eslint` dependency
 * can be deleted outright.
 */
const TYPE_AWARE_RULES = [
	'no-plugin-as-component',
	'no-unsupported-api',
	'no-view-references-in-plugin',
	'prefer-create-el',
	'prefer-file-manager-trash-file',
	'prefer-instanceof',
] as const;

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'main.js',
		'test-vault',
		'tests',
		'docs',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'scripts',
		'versions.json',
		'package.json',
		'pnpm-lock.yaml',
		'tsconfig.json',
	]),
	{
		files: ['src/**/*.ts'],
		plugins: { obsidianmd: obsidianmd as never },
		languageOptions: {
			parser: tseslint.parser,
			globals: { ...globals.browser, ...globals.node },
			parserOptions: {
				// These rules exist precisely because they need the type
				// checker, so the project service has to be on.
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: Object.fromEntries(
			TYPE_AWARE_RULES.map((rule) => [`obsidianmd/${rule}`, 'error']),
		),
	},
);
