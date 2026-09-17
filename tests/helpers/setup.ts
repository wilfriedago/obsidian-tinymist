/**
 * Test environment shim.
 *
 * The Tinymist adapter schedules its timers through `window`, which is what
 * Obsidian expects so a timer belongs to the window the plugin runs in. These
 * tests run under Node, where there is no `window`, so one is pointed at the
 * global object. The adapter's behaviour is identical either way — `window.
 * setTimeout` and the global `setTimeout` are the same function in a renderer.
 *
 * This is a shim for the *test host*, not a polyfill shipped to users.
 */
if (typeof globalThis.window === 'undefined') {
	(globalThis as { window?: unknown }).window = globalThis;
}
