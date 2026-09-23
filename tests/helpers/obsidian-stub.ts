/**
 * A runtime stand-in for the `obsidian` module.
 *
 * The published `obsidian` package ships type declarations only; the real
 * implementation lives inside the app. Vitest therefore cannot import it, so
 * this supplies just enough behaviour for the units under test. Anything that
 * genuinely needs the app is covered by the manual UX pass instead.
 */

export class Notice {
	static readonly shown: string[] = [];
	constructor(public message: string) {
		Notice.shown.push(message);
	}
	hide(): void {}
	setMessage(message: string): this {
		this.message = message;
		return this;
	}
}

export function setIcon(element: { textContent: string | null }, icon: string): void {
	element.textContent = `[${icon}]`;
}

export function normalizePath(path: string): string {
	return path
		.replace(/\\/g, '/')
		.replace(/\/{2,}/g, '/')
		.replace(/^\/+|\/+$/g, '')
		.replace(/ /g, ' ')
		.normalize();
}

export class TAbstractFile {
	path = '';
	name = '';
}

export class TFile extends TAbstractFile {
	basename = '';
	extension = '';
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
}

export class Component {
	load(): void {}
	unload(): void {}
	register(): void {}
	registerEvent(): void {}
	registerDomEvent(): void {}
}

export class View extends Component {
	async onOpen(): Promise<void> {}
	setEphemeralState(_state: unknown): void {}
}
export class ItemView extends View {}
export class FileView extends ItemView {}
export class EditableFileView extends FileView {}
export class TextFileView extends EditableFileView {
	async onUnloadFile(): Promise<void> {}
}
export class Plugin extends Component {}
export class PluginSettingTab {}
export class Setting {}
export class Modal {}
export class FileSystemAdapter {}

export const Platform = { isDesktopApp: true, isMobile: false };

export function requireApiVersion(): boolean {
	return true;
}
