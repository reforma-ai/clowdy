import manifest from 'material-icon-theme/dist/material-icons.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';

import { createIconResolver, iconName, iconUrl } from './fileIconTheme';

const resolve = createIconResolver({
    file: 'file',
    folder: 'folder',
    folderExpanded: 'folder-open',
    fileNames: { 'package.json': 'nodejs', 'README.md': 'readme' },
    fileExtensions: { json: 'json', tsx: 'react_ts', 'test.tsx': 'test-tsx', toml: 'toml' },
    languageIds: { typescript: 'typescript' },
    folderNames: { src: 'folder-src', '.github/workflows': 'folder-workflows' },
    folderNamesExpanded: { src: 'folder-src-open' },
    light: {
        fileExtensions: { toml: 'toml_light' },
        folderNames: { src: 'folder-src_light' },
    },
});

describe('file icons', () => {
    it('should pick a file name over an extension, a longer extension over a shorter one, then the language', () => {
        expect(resolve('package.json', 'file')).toBe('nodejs');
        expect(resolve('docs/readme.MD', 'file')).toBe('readme');
        expect(resolve('settings.json', 'file')).toBe('json');
        expect(resolve('ui/button.test.tsx', 'file')).toBe('test-tsx');
        expect(resolve('ui/button.tsx', 'file')).toBe('react_ts');
        expect(resolve('lib/index.ts', 'file')).toBe('typescript');
        expect(resolve('Makefile', 'file')).toBe('file');
        expect(resolve('constructor', 'file')).toBe('file');
    });

    it('should pick folder icons by name and state, with the parent folder when the theme names it', () => {
        expect(resolve('src', 'directory')).toBe('folder-src');
        expect(resolve('app/src', 'directory', { open: true })).toBe('folder-src-open');
        expect(resolve('.github/workflows', 'directory')).toBe('folder-workflows');
        expect(resolve('workflows', 'directory')).toBe('folder');
        expect(resolve('app', 'directory', { open: true })).toBe('folder-open');
    });

    it('should prefer light variants for a light color scheme and fall back to the others', () => {
        expect(resolve('config.toml', 'file', { light: true })).toBe('toml_light');
        expect(resolve('config.toml', 'file')).toBe('toml');
        expect(resolve('src', 'directory', { light: true })).toBe('folder-src_light');
        expect(resolve('package.json', 'file', { light: true })).toBe('nodejs');
    });

    it('should have an SVG asset for every icon the Material theme names', () => {
        const missing = Object.keys(manifest.iconDefinitions).filter(name => !iconUrl(name));

        expect(missing).toEqual([]);
        expect(iconUrl(iconName('app/page.tsx', 'file'))).toContain('.svg');
    });
});
