import { describe, expect, it, vi } from 'vitest';

import { openInMenuItems } from './openInMenuItems';

import type { FileEntry } from '@clowdy/file-manager';
import type { OpenEffects } from '../openWith';

const FOLDER = { id: 'fld_app', path: '/Users/dev/app' };
const GIT = { remoteUrl: 'git@github.com:acme/app.git', branch: 'main' };
const PROGRAMS = {
    fileManager: { id: 'finder', name: 'Finder' },
    editor: { id: 'cursor', name: 'Cursor' },
    terminal: { id: 'ghostty', name: 'Ghostty' },
};
const FILE: FileEntry = { path: 'src/index.ts', kind: 'file' };
const DIRECTORY: FileEntry = { path: 'src', kind: 'directory' };

const effects = (): OpenEffects => ({ openPath: vi.fn(), openUrl: vi.fn(), copy: vi.fn() });
const itemsOf = (targets: readonly FileEntry[], options: Partial<Parameters<typeof openInMenuItems>[0]> = {}) => openInMenuItems({ projectId: 'p-app', folder: FOLDER, programs: PROGRAMS, git: GIT, effects: effects(), ...options })(targets);
const labels = (items: ReturnType<typeof itemsOf>) => items.map(item => [item.label, item.children?.map(child => child.label)]);

describe('what the Files tree\'s row menu is given to open a row in', () => {
    it('is a Copy path submenu of the two paths, then an Open in… submenu of the editor, the file manager showing the file and GitHub, for a file', () => {
        expect(labels(itemsOf([FILE]))).toEqual([
            ['Copy path', ['Absolute path', 'Relative path']],
            ['Open in…', ['Open in Cursor', 'Show in Finder', 'Open in GitHub']],
        ]);
    });

    it('adds the terminal for a folder, which the file manager opens', () => {
        expect(labels(itemsOf([DIRECTORY]))).toEqual([
            ['Copy path', ['Absolute path', 'Relative path']],
            ['Open in…', ['Open in Cursor', 'Open in Finder', 'Open in Ghostty', 'Open in GitHub']],
        ]);
    });

    it('has no Open in Files, since the tree is the built-in file manager', () => {
        const [, submenu] = itemsOf([FILE]);

        expect(submenu!.children!.map(child => child.id)).not.toContain('files');
    });

    it('has nothing for a selection of several rows, or for none', () => {
        expect(itemsOf([FILE, DIRECTORY])).toEqual([]);
        expect(itemsOf([])).toEqual([]);
    });

    it('gives both submenus an icon, since every row of the menu has one', () => {
        expect(itemsOf([FILE]).map(item => item.icon)).not.toContain(undefined);
    });

    it('leaves out Open in… when nothing opens the row (no program and no GitHub page), and keeps Copy path', () => {
        expect(labels(itemsOf([FILE], { programs: {}, git: undefined }))).toEqual([['Copy path', ['Absolute path', 'Relative path']]]);
    });

    it('runs each item against the row\'s path inside the folder the tree shows', () => {
        const done = effects();
        const [copying, opening] = itemsOf([FILE], { effects: done });
        const [editor, manager, github] = opening!.children!;
        const [copyPath, copyRelative] = copying!.children!;

        editor!.onAction();
        manager!.onAction();
        github!.onAction();
        copyPath!.onAction();
        copyRelative!.onAction();

        expect(done.openPath).toHaveBeenNthCalledWith(1, '/Users/dev/app/src/index.ts', 'editor', PROGRAMS.editor);
        expect(done.openPath).toHaveBeenNthCalledWith(2, '/Users/dev/app/src/index.ts', 'fileManager', PROGRAMS.fileManager);
        expect(done.openUrl).toHaveBeenCalledExactlyOnceWith('https://github.com/acme/app/blob/main/src/index.ts');
        expect(done.copy).toHaveBeenNthCalledWith(1, '/Users/dev/app/src/index.ts');
        expect(done.copy).toHaveBeenNthCalledWith(2, 'src/index.ts');
    });
});
