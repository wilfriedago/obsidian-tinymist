import { Plugin } from 'obsidian';

import { registerCommands } from './plugin/commands';
import { TypstRuntime } from './plugin/runtime';
import { TypstSettingTab } from './settings/settings-tab';

/**
 * Plugin entry point.
 *
 * Composition only: every behaviour lives in a subsystem, and this class exists
 * to build them, hand Obsidian the registrations, and tear them down again.
 */
export default class TinymistPlugin extends Plugin {
	private runtime: TypstRuntime | null = null;

	override async onload(): Promise<void> {
		const runtime = new TypstRuntime(this.app, this);
		this.runtime = runtime;

		await runtime.load();

		runtime.attachStatusBar(this.addStatusBarItem());
		registerCommands(this, runtime);

		this.addSettingTab(
			new TypstSettingTab(this.app, this, {
				getSettings: () => runtime.getSettings(),
				updateSettings: (patch) => runtime.updateSettings(patch),
				restartServer: () => runtime.restartServer(),
				describeServerState: () => runtime.describeServerState(),
				getDetectedVersion: () => runtime.getDetectedVersion(),
				getDetectedTypstVersion: () => runtime.getDetectedTypstVersion(),
				describeExecutable: () => runtime.describeExecutable(),
			}),
		);
	}

	override onunload(): void {
		// Leaves are intentionally not detached: Obsidian restores them on the
		// next load, and detaching here would lose the user's layout.
		this.runtime?.unload();
		this.runtime = null;
	}
}
