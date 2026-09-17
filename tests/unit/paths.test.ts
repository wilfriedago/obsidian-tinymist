import { describe, expect, it } from 'vitest';

import {
	absolutePathToFileUri,
	absoluteToVaultPath,
	containVaultPath,
	extensionOf,
	fileUriToAbsolutePath,
	isInsideVault,
	normalizeAbsolutePath,
	parentVaultPath,
	vaultPathToAbsolute,
	withExtension,
} from '../../src/shared/paths';

describe('normalizeAbsolutePath', () => {
	it('collapses separators and resolves dot segments', () => {
		expect(normalizeAbsolutePath('/a//b/./c')).toBe('/a/b/c');
		expect(normalizeAbsolutePath('/a/b/../c')).toBe('/a/c');
		expect(normalizeAbsolutePath('/a/b/c/')).toBe('/a/b/c');
	});

	it('keeps a Windows drive prefix and normalizes backslashes', () => {
		expect(normalizeAbsolutePath('C:\\vault\\notes')).toBe('C:/vault/notes');
		expect(normalizeAbsolutePath('C:\\vault\\..\\other')).toBe('C:/other');
	});
});

describe('containVaultPath', () => {
	it('strips segments that would climb out of the vault', () => {
		expect(containVaultPath('../../etc/passwd')).toBe('etc/passwd');
		expect(containVaultPath('papers/../secrets.typ')).toBe('secrets.typ');
		expect(containVaultPath('/leading/slash.typ')).toBe('leading/slash.typ');
	});
});

describe('vaultPathToAbsolute', () => {
	it('joins onto the vault base', () => {
		expect(vaultPathToAbsolute('/home/me/vault', 'papers/main.typ')).toBe(
			'/home/me/vault/papers/main.typ',
		);
	});

	it('cannot be made to escape the vault', () => {
		expect(vaultPathToAbsolute('/home/me/vault', '../../../etc/passwd')).toBe(
			'/home/me/vault/etc/passwd',
		);
	});
});

describe('absoluteToVaultPath', () => {
	it('returns the relative path for a file inside the vault', () => {
		expect(absoluteToVaultPath('/home/me/vault', '/home/me/vault/a/b.typ')).toBe('a/b.typ');
	});

	it('returns null for a file outside the vault', () => {
		expect(absoluteToVaultPath('/home/me/vault', '/home/me/other/b.typ')).toBeNull();
		// A sibling directory whose name merely starts with the vault name.
		expect(absoluteToVaultPath('/home/me/vault', '/home/me/vault-backup/b.typ')).toBeNull();
	});

	it('treats the vault directory itself as the empty path', () => {
		expect(absoluteToVaultPath('/home/me/vault', '/home/me/vault')).toBe('');
	});

	it('compares case-insensitively only on Windows paths', () => {
		expect(absoluteToVaultPath('C:/Vault', 'c:/vault/a.typ')).toBe('a.typ');
		expect(absoluteToVaultPath('/Vault', '/vault/a.typ')).toBeNull();
	});
});

describe('isInsideVault', () => {
	it('answers containment', () => {
		expect(isInsideVault('/v', '/v/a/b.typ')).toBe(true);
		expect(isInsideVault('/v', '/w/a/b.typ')).toBe(false);
	});
});

describe('file URIs', () => {
	it('round-trips a POSIX path', () => {
		const path = '/home/me/vault/papers/main.typ';
		expect(fileUriToAbsolutePath(absolutePathToFileUri(path))).toBe(path);
	});

	it('round-trips a path with spaces and non-ASCII characters', () => {
		const path = '/home/me/vault/mes notes/résumé été.typ';
		const uri = absolutePathToFileUri(path);
		expect(uri).toContain('%20');
		expect(fileUriToAbsolutePath(uri)).toBe(path);
	});

	it('encodes a Windows path with the extra slash and an upper-case drive', () => {
		expect(absolutePathToFileUri('c:\\vault\\main.typ')).toBe('file:///C:/vault/main.typ');
		expect(fileUriToAbsolutePath('file:///C:/vault/main.typ')).toBe('C:/vault/main.typ');
	});

	it('refuses non-file and remote-host URIs', () => {
		expect(fileUriToAbsolutePath('https://example.com/a.typ')).toBeNull();
		expect(fileUriToAbsolutePath('file://server/share/a.typ')).toBeNull();
	});

	it('does not encode the separators themselves', () => {
		expect(absolutePathToFileUri('/a/b/c.typ')).toBe('file:///a/b/c.typ');
	});
});

describe('extension helpers', () => {
	it('reads an extension', () => {
		expect(extensionOf('a/b/main.TYP')).toBe('typ');
		expect(extensionOf('a/b/Makefile')).toBe('');
		expect(extensionOf('a/b/.hidden')).toBe('');
	});

	it('replaces an extension', () => {
		expect(withExtension('papers/main.typ', 'pdf')).toBe('papers/main.pdf');
		expect(withExtension('papers/main', 'pdf')).toBe('papers/main.pdf');
	});

	it('reads a parent directory', () => {
		expect(parentVaultPath('a/b/c.typ')).toBe('a/b');
		expect(parentVaultPath('c.typ')).toBe('');
	});
});
