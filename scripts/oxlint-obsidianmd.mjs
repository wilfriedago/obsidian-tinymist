import { createRequire } from 'node:module'
/**
 * `eslint-plugin-obsidianmd`, repackaged so oxlint can run every rule in it.
 *
 * Six of the rules call `getParserServices()` and ask the TypeScript checker
 * about the code: `no-plugin-as-component`, `no-unsupported-api`,
 * `no-view-references-in-plugin`, `prefer-create-el`,
 * `prefer-file-manager-trash-file` and `prefer-instanceof`. Oxlint's JS plugin
 * host has no parser services, so those rules throw there. This module builds
 * the services itself: it creates a TypeScript program from `tsconfig.json`
 * and hands the six rules a context whose `sourceCode.parserServices` looks
 * like the one `@typescript-eslint/parser` would have produced. The rules run
 * unmodified. The other rules pass straight through.
 *
 * The program uses the TypeScript the plugin itself depends on (a 5.x release
 * with the classic compiler API), not the project's own compiler. The rules
 * import that same copy, so symbol flags and types stay consistent. The
 * project's native TypeScript has no JS API to offer anyway.
 */
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { commands } from 'eslint-plugin-obsidianmd/dist/lib/rules/commands/index.js'
import detachLeaves from 'eslint-plugin-obsidianmd/dist/lib/rules/detachLeaves.js'
import editorDropPaste from 'eslint-plugin-obsidianmd/dist/lib/rules/editorDropPaste.js'
import hardcodedConfigPath from 'eslint-plugin-obsidianmd/dist/lib/rules/hardcodedConfigPath.js'
import noForbiddenElements from 'eslint-plugin-obsidianmd/dist/lib/rules/noForbiddenElements.js'
import noGlobalThis from 'eslint-plugin-obsidianmd/dist/lib/rules/noGlobalThis.js'
import noNodejsModules from 'eslint-plugin-obsidianmd/dist/lib/rules/noNodejsModules.js'
import noPluginAsComponent from 'eslint-plugin-obsidianmd/dist/lib/rules/noPluginAsComponent.js'
import noSampleCode from 'eslint-plugin-obsidianmd/dist/lib/rules/noSampleCode.js'
import noStaticStylesAssignment from 'eslint-plugin-obsidianmd/dist/lib/rules/noStaticStylesAssignment.js'
import noTFileTFolderCast from 'eslint-plugin-obsidianmd/dist/lib/rules/noTFileTFolderCast.js'
import noUnsupportedApi from 'eslint-plugin-obsidianmd/dist/lib/rules/noUnsupportedApi.js'
import noViewReferencesInPlugin from 'eslint-plugin-obsidianmd/dist/lib/rules/noViewReferencesInPlugin.js'
import objectAssign from 'eslint-plugin-obsidianmd/dist/lib/rules/objectAssign.js'
import platform from 'eslint-plugin-obsidianmd/dist/lib/rules/platform.js'
import preferAbstractInputSuggest from 'eslint-plugin-obsidianmd/dist/lib/rules/preferAbstractInputSuggest.js'
import preferActiveDoc from 'eslint-plugin-obsidianmd/dist/lib/rules/preferActiveDoc.js'
import preferCreateEl from 'eslint-plugin-obsidianmd/dist/lib/rules/preferCreateEl.js'
import preferFileManagerTrashFile from 'eslint-plugin-obsidianmd/dist/lib/rules/preferFileManagerTrashFile.js'
import preferGetLanguage from 'eslint-plugin-obsidianmd/dist/lib/rules/preferGetLanguage.js'
import preferInstanceof from 'eslint-plugin-obsidianmd/dist/lib/rules/preferInstanceof.js'
import preferWindowTimers from 'eslint-plugin-obsidianmd/dist/lib/rules/preferWindowTimers.js'
import regexLookbehind from 'eslint-plugin-obsidianmd/dist/lib/rules/regexLookbehind.js'
import ruleCustomMessage from 'eslint-plugin-obsidianmd/dist/lib/rules/ruleCustomMessage.js'
import sampleNames from 'eslint-plugin-obsidianmd/dist/lib/rules/sampleNames.js'
import { settingsTab } from 'eslint-plugin-obsidianmd/dist/lib/rules/settingsTab/index.js'
import { ui } from 'eslint-plugin-obsidianmd/dist/lib/rules/ui/index.js'
import validateLicense from 'eslint-plugin-obsidianmd/dist/lib/rules/validateLicense.js'
import validateManifest from 'eslint-plugin-obsidianmd/dist/lib/rules/validateManifest.js'
import { vault } from 'eslint-plugin-obsidianmd/dist/lib/rules/vault/index.js'

const ts = createRequire(fileURLToPath(import.meta.resolve('eslint-plugin-obsidianmd')))('typescript')

/**
 * The same rule map as the package's own index. The index cannot be imported:
 * it also builds the ESLint presets, which load `typescript-eslint`, and that
 * refuses to start under TypeScript 7.
 */
const RULES = {
	'commands/no-command-in-command-id': commands.noCommandInCommandId,
	'commands/no-command-in-command-name': commands.noCommandInCommandName,
	'commands/no-default-hotkeys': commands.noDefaultHotkeys,
	'commands/no-plugin-id-in-command-id': commands.noPluginIdInCommandId,
	'commands/no-plugin-name-in-command-name': commands.noPluginNameInCommandName,
	'settings-tab/no-manual-html-headings': settingsTab.noManualHtmlHeadings,
	'settings-tab/no-problematic-settings-headings': settingsTab.noProblematicSettingsHeadings,
	'settings-tab/require-display': settingsTab.requireDisplay,
	'settings-tab/prefer-setting-definitions': settingsTab.preferSettingDefinitions,
	'settings-tab/prefer-update-over-display': settingsTab.preferUpdateOverDisplay,
	'settings-tab/no-deprecated-display': settingsTab.noDeprecatedDisplay,
	'vault/iterate': vault.iterate,
	'detach-leaves': detachLeaves,
	'editor-drop-paste': editorDropPaste,
	'hardcoded-config-path': hardcodedConfigPath,
	'no-forbidden-elements': noForbiddenElements,
	'no-global-this': noGlobalThis,
	'no-plugin-as-component': noPluginAsComponent,
	'no-sample-code': noSampleCode,
	'no-tfile-tfolder-cast': noTFileTFolderCast,
	'no-view-references-in-plugin': noViewReferencesInPlugin,
	'no-static-styles-assignment': noStaticStylesAssignment,
	'object-assign': objectAssign,
	platform,
	'prefer-abstract-input-suggest': preferAbstractInputSuggest,
	'prefer-active-doc': preferActiveDoc,
	'prefer-create-el': preferCreateEl,
	'prefer-file-manager-trash-file': preferFileManagerTrashFile,
	'prefer-instanceof': preferInstanceof,
	'prefer-window-timers': preferWindowTimers,
	'prefer-get-language': preferGetLanguage,
	'regex-lookbehind': regexLookbehind,
	'sample-names': sampleNames,
	'validate-manifest': validateManifest,
	'validate-license': validateLicense,
	'rule-custom-message': ruleCustomMessage,
	'no-nodejs-modules': noNodejsModules,
	'no-unsupported-api': noUnsupportedApi,
	'ui/sentence-case': ui.sentenceCase,
	'ui/sentence-case-json': ui.sentenceCaseJson,
	'ui/sentence-case-locale-module': ui.sentenceCaseLocaleModule
}

const TYPE_AWARE_RULES = new Set([
	'no-plugin-as-component',
	'no-unsupported-api',
	'no-view-references-in-plugin',
	'prefer-create-el',
	'prefer-file-manager-trash-file',
	'prefer-instanceof'
])

/** One program per tsconfig, reused for every file it covers. */
const programs = new Map()

function loadConfig(configPath) {
	const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile)
	if (error) {
		throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'))
	}
	return ts.parseJsonConfigFileContent(config, ts.sys, dirname(configPath))
}

/**
 * Returns a program in which `fileName` has exactly `text`. The linted text
 * can differ from the file on disk: `--fix` rewrites it between passes, and
 * the editor integration lints unsaved buffers. When it differs, the program
 * is rebuilt with that one file swapped in, reusing everything else from the
 * previous program.
 */
function programFor(fileName, text) {
	const configPath = ts.findConfigFile(dirname(fileName), ts.sys.fileExists)
	if (!configPath) {
		throw new Error(`No tsconfig.json found for ${fileName}`)
	}
	let entry = programs.get(configPath)
	if (!entry) {
		entry = { config: loadConfig(configPath), overrides: new Map(), program: undefined }
		programs.set(configPath, entry)
	}
	const current = entry.program?.getSourceFile(fileName)
	if (current && current.text === text) {
		return entry.program
	}

	entry.overrides.set(fileName, text)
	const host = ts.createCompilerHost(entry.config.options, true)
	const readFile = host.readFile.bind(host)
	host.readFile = (name) => entry.overrides.get(name) ?? readFile(name)
	const rootNames = entry.config.fileNames.includes(fileName) ? entry.config.fileNames : [...entry.config.fileNames, fileName]
	entry.program = ts.createProgram({
		rootNames,
		options: entry.config.options,
		host,
		oldProgram: entry.program
	})
	return entry.program
}

/**
 * Finds the TypeScript node for an ESTree node: the deepest node spanning
 * exactly the same source range, which is the node `typescript-estree`
 * converts from. If nothing matches exactly, the deepest node that contains
 * the range is the closest thing, and still gives the checker something
 * sensible to look at.
 */
function findTsNode(sourceFile, [start, end]) {
	let node = sourceFile
	let exact
	let containing = sourceFile
	for (;;) {
		if (node.getStart(sourceFile) === start && node.end === end) {
			exact = node
		}
		const child = ts.forEachChild(node, (c) => (c.pos <= start && end <= c.end ? c : undefined))
		if (!child) {
			return exact ?? containing
		}
		node = child
		if (child.getStart(sourceFile) <= start) {
			containing = child
		}
	}
}

function createParserServices(fileName, text) {
	const program = programFor(fileName, text)
	const sourceFile = program.getSourceFile(fileName)
	if (!sourceFile) {
		throw new Error(`${fileName} is not part of the TypeScript program`)
	}
	const checker = program.getTypeChecker()
	const esTreeNodeToTSNodeMap = {
		get: (node) => findTsNode(sourceFile, node.range),
		has: () => true
	}
	return {
		program,
		esTreeNodeToTSNodeMap,
		// The rules never map back. `getParserServices()` only checks this
		// exists.
		tsNodeToESTreeNodeMap: new WeakMap(),
		getTypeAtLocation: (node) => checker.getTypeAtLocation(esTreeNodeToTSNodeMap.get(node)),
		getSymbolAtLocation: (node) => checker.getSymbolAtLocation(esTreeNodeToTSNodeMap.get(node)),
		emitDecoratorMetadata: undefined,
		experimentalDecorators: undefined,
		isolatedDeclarations: undefined
	}
}

/**
 * Forwards every read to `target`, except the properties in `extra`. Methods
 * are bound to `target` because oxlint's context objects check their receiver.
 * The proxy wraps an empty object rather than `target` itself: oxlint freezes
 * `sourceCode.parserServices`, and a proxy may not report a different value
 * for a frozen property of its own target.
 */
function overlay(target, extra) {
	return new Proxy(
		{},
		{
			get(_, key) {
				if (Object.hasOwn(extra, key)) {
					return extra[key]
				}
				const value = Reflect.get(target, key, target)
				return typeof value === 'function' ? value.bind(target) : value
			}
		}
	)
}

function withTypeInformation(rule) {
	return {
		...rule,
		create(context) {
			const parserServices = createParserServices(context.physicalFilename, context.sourceCode.text)
			return rule.create(
				overlay(context, {
					sourceCode: overlay(context.sourceCode, { parserServices }),
					// `getParserServices()` reads this to name the parser in its
					// error message, which would crash if it were missing.
					languageOptions: context.languageOptions ?? {}
				})
			)
		}
	}
}

export default {
	meta: { name: 'obsidianmd' },
	rules: Object.fromEntries(
		Object.entries(RULES).map(([name, rule]) => [name, TYPE_AWARE_RULES.has(name) ? withTypeInformation(rule) : rule])
	)
}
