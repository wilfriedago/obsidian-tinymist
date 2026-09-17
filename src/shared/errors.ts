/**
 * Every user-visible failure in this plugin is one of these categories. The
 * category decides the headline and the recovery hint; the detail carries the
 * specifics. Raw stack traces never reach this layer — they go to the log.
 */
export type TypstErrorCode =
	| 'tinymist-not-configured'
	| 'tinymist-not-found'
	| 'tinymist-invalid-executable'
	| 'tinymist-start-failed'
	| 'tinymist-crashed'
	| 'lsp-init-failed'
	| 'lsp-request-failed'
	| 'compile-failed'
	| 'export-failed'
	| 'preview-unavailable'
	| 'project-invalid'
	| 'document-sync-failed'
	| 'platform-unsupported';

/** Headline shown to the user, per category. Sentence case, no trailing period. */
const HEADLINES: Record<TypstErrorCode, string> = {
	'tinymist-not-configured': 'Tinymist is not configured',
	'tinymist-not-found': 'Tinymist could not be found',
	'tinymist-invalid-executable': 'The configured Tinymist executable is not usable',
	'tinymist-start-failed': 'Tinymist could not be started',
	'tinymist-crashed': 'Tinymist stopped unexpectedly',
	'lsp-init-failed': 'Tinymist failed to initialize',
	'lsp-request-failed': 'Tinymist could not answer a request',
	'compile-failed': 'The Typst document could not be compiled',
	'export-failed': 'The Typst document could not be exported',
	'preview-unavailable': 'The Typst preview is unavailable',
	'project-invalid': 'The Typst project configuration is invalid',
	'document-sync-failed': 'The document could not be synchronized with Tinymist',
	'platform-unsupported': 'This feature requires Obsidian on desktop',
};

/** Recovery hint shown under the reason. Empty string means "no hint". */
const HINTS: Record<TypstErrorCode, string> = {
	'tinymist-not-configured': 'Set the Tinymist executable path in the plugin settings.',
	'tinymist-not-found': 'Install Tinymist, or set an explicit path in the plugin settings.',
	'tinymist-invalid-executable': 'Check the path in the plugin settings points at a Tinymist binary.',
	'tinymist-start-failed': 'Check the executable path and its permissions in the plugin settings.',
	'tinymist-crashed': 'Run the "Restart Tinymist" command to recover.',
	'lsp-init-failed': 'Run the "Restart Tinymist" command, then check the logs.',
	'lsp-request-failed': '',
	'compile-failed': 'Check the reported diagnostics in the editor.',
	'export-failed': '',
	'preview-unavailable': 'Run the "Restart Tinymist" command, then reopen the preview.',
	'project-invalid': 'Check the project root setting and any typst.toml in the project.',
	'document-sync-failed': 'Run the "Restart Tinymist" command to resynchronize.',
	'platform-unsupported': '',
};

/**
 * A categorized, user-presentable error. `cause` keeps the original failure for
 * the log without leaking it into the UI.
 */
export class TypstError extends Error {
	readonly code: TypstErrorCode;
	/** Extra key/value context shown in the detail block, e.g. the executable path. */
	readonly context: Readonly<Record<string, string>>;

	/** The original failure, kept for the log and never shown to the user. */
	readonly cause: unknown;

	constructor(
		code: TypstErrorCode,
		reason: string,
		options: { context?: Record<string, string>; cause?: unknown } = {},
	) {
		// `Error`'s `cause` option is ES2022; the build targets ES2021, so the
		// original failure is carried on an own field instead.
		super(reason);
		this.cause = options.cause;
		this.name = 'TypstError';
		this.code = code;
		this.context = Object.freeze({ ...options.context });
	}

	get headline(): string {
		return HEADLINES[this.code];
	}

	get hint(): string {
		return HINTS[this.code];
	}

	/**
	 * The multi-line message shown in a notice or an error panel. Actionable,
	 * and free of stack traces.
	 */
	toUserMessage(): string {
		const lines = [this.headline, ''];
		for (const [key, value] of Object.entries(this.context)) {
			lines.push(`${key}: ${value}`);
		}
		if (Object.keys(this.context).length > 0) {
			lines.push('');
		}
		lines.push(this.message);
		if (this.hint) {
			lines.push('', this.hint);
		}
		return lines.join('\n');
	}
}

/** Narrows an unknown thrown value to a readable one-line reason. */
export function describeUnknownError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === 'string') {
		return error;
	}
	return 'Unknown error.';
}

/** Wraps any thrown value as a `TypstError` without losing the original. */
export function asTypstError(
	error: unknown,
	code: TypstErrorCode,
	context?: Record<string, string>,
): TypstError {
	if (error instanceof TypstError) {
		return error;
	}
	return new TypstError(code, describeUnknownError(error), { context: context ?? {}, cause: error });
}
