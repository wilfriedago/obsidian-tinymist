/**
 * Structured logging with a configurable level.
 *
 * Deliberate omissions, per the plugin's privacy rules: document contents are
 * never logged, and vault paths are logged vault-relative rather than absolute
 * so a log paste does not reveal the user's home directory.
 */
export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = {
	silent: 0,
	error: 1,
	warn: 2,
	info: 3,
	debug: 4,
};

export function isLogLevel(value: unknown): value is LogLevel {
	return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/** A single retained log record, used by the "Show logs" command. */
export interface LogRecord {
	readonly time: number;
	readonly level: Exclude<LogLevel, 'silent'>;
	readonly scope: string;
	readonly message: string;
	readonly detail?: string;
}

/** How many records the in-memory ring buffer keeps. */
const RING_CAPACITY = 500;

/**
 * Sink shared by every `Logger`. Keeps a bounded history so the user can read
 * recent activity without having the console open from the start.
 */
export class LogSink {
	private level: LogLevel = 'warn';
	private readonly records: LogRecord[] = [];

	setLevel(level: LogLevel): void {
		this.level = level;
	}

	getLevel(): LogLevel {
		return this.level;
	}

	enabled(level: Exclude<LogLevel, 'silent'>): boolean {
		return LEVEL_RANK[this.level] >= LEVEL_RANK[level];
	}

	write(record: LogRecord): void {
		this.records.push(record);
		if (this.records.length > RING_CAPACITY) {
			this.records.splice(0, this.records.length - RING_CAPACITY);
		}

		// This is the plugin's only console writer, and every call is gated on a
		// level the user chooses. The default is `warn`, so a normal install
		// stays quiet — which is what the "avoid unnecessary logging" guideline
		// is actually asking for.
		const prefix = `[tinymist:${record.scope}]`;
		const args: unknown[] = [prefix, record.message];
		if (record.detail !== undefined) {
			args.push(record.detail);
		}

		// Mapped onto the console's own levels rather than `console.log`, so the
		// developer console's level filter can hide plugin chatter the same way
		// it hides Obsidian's.
		switch (record.level) {
			case 'error':
				console.error(...args);
				break;
			case 'warn':
				console.warn(...args);
				break;
			case 'info':
			case 'debug':
				// `console.debug`, so these land in the console's Verbose tier
				// and stay hidden unless the user goes looking for them.
				console.debug(...args);
				break;
		}
	}

	history(): readonly LogRecord[] {
		return this.records;
	}

	clear(): void {
		this.records.length = 0;
	}
}

/** A scoped view over a `LogSink`. One per subsystem. */
export class Logger {
	constructor(
		private readonly sink: LogSink,
		private readonly scope: string,
	) {}

	child(scope: string): Logger {
		return new Logger(this.sink, `${this.scope}.${scope}`);
	}

	error(message: string, detail?: unknown): void {
		this.emit('error', message, detail);
	}

	warn(message: string, detail?: unknown): void {
		this.emit('warn', message, detail);
	}

	info(message: string, detail?: unknown): void {
		this.emit('info', message, detail);
	}

	debug(message: string, detail?: unknown): void {
		this.emit('debug', message, detail);
	}

	private emit(level: Exclude<LogLevel, 'silent'>, message: string, detail?: unknown): void {
		if (!this.sink.enabled(level)) {
			return;
		}
		this.sink.write({
			time: Date.now(),
			level,
			scope: this.scope,
			message,
			...(detail === undefined ? {} : { detail: formatDetail(detail) }),
		});
	}
}

function formatDetail(detail: unknown): string {
	if (typeof detail === 'string') {
		return detail;
	}
	if (detail instanceof Error) {
		return `${detail.name}: ${detail.message}`;
	}
	try {
		return JSON.stringify(detail);
	} catch {
		return String(detail);
	}
}
