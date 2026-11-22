import { describe, expect, it, vi } from 'vitest';

import { absolutePath, githubLink, openActions, type FolderGit, type OpenEffects, type OpenTarget } from './openTarget';

const GIT: FolderGit = { remoteUrl: 'git@github.com:acme/app.git', branch: 'feature/new-menu' };
const FOLDER = { id: 'fld_app', path: '/Users/dev/app' };
const target = (relative: string, kind: OpenTarget['kind']): OpenTarget => ({ projectId: 'p-app', folder: FOLDER, path: absolutePath(FOLDER.path, relative), relative, kind });

const PROGRAMS = {
    fileManager: { id: 'finder', name: 'Finder' },
    editor: { id: 'cursor', name: 'Cursor' },
    terminal: { id: 'ghostty', name: 'Ghostty' },
};

function effects(): OpenEffects {
    return { openPath: vi.fn(), openUrl: vi.fn(), copy: vi.fn() };
}

describe('where a path is on the disk', () => {
    it('joins a folder and a path inside it with the folder\'s own separator', () => {
        expect(absolutePath('/Users/dev/app', 'src/index.ts')).toBe('/Users/dev/app/src/index.ts');
        expect(absolutePath('/Users/dev/app/', 'src')).toBe('/Users/dev/app/src');
        expect(absolutePath('C:\\Users\\dev\\app', 'src/index.ts')).toBe('C:\\Users\\dev\\app\\src\\index.ts');
        expect(absolutePath('/Users/dev/app', '')).toBe('/Users/dev/app');
    });
});

describe('the page on GitHub', () => {
    it('is the repository for the folder itself, whatever branch is checked out', () => {
        expect(githubLink(GIT, { relative: '', kind: 'directory' })).toBe('https://github.com/acme/app');
        expect(githubLink({ remoteUrl: 'https://github.com/acme/app.git' }, { relative: '', kind: 'directory' })).toBe('https://github.com/acme/app');
    });

    it('is the file on the branch that is checked out, and a folder in it a tree of that branch, each part made safe for an address', () => {
        expect(githubLink(GIT, { relative: 'src/index.ts', kind: 'file' })).toBe('https://github.com/acme/app/blob/feature/new-menu/src/index.ts');
        expect(githubLink(GIT, { relative: 'src/menu', kind: 'directory' })).toBe('https://github.com/acme/app/tree/feature/new-menu/src/menu');
        expect(githubLink(GIT, { relative: 'docs/my notes#1.md', kind: 'file' })).toBe('https://github.com/acme/app/blob/feature/new-menu/docs/my%20notes%231.md');
    });

    it('names the short hash on a detached HEAD', () => {
        expect(githubLink({ ...GIT, branch: 'a1b2c3d', detached: true }, { relative: 'README.md', kind: 'file' })).toBe('https://github.com/acme/app/blob/a1b2c3d/README.md');
    });

    it('is nothing for a file without a branch to name, for another host, and for no remote', () => {
        expect(githubLink({ remoteUrl: GIT.remoteUrl }, { relative: 'README.md', kind: 'file' })).toBeUndefined();
        expect(githubLink({ remoteUrl: 'git@gitlab.com:acme/app.git', branch: 'main' }, { relative: '', kind: 'directory' })).toBeUndefined();
        expect(githubLink({ remoteUrl: '/srv/git/app.git', branch: 'main' }, { relative: '', kind: 'directory' })).toBeUndefined();
        expect(githubLink({ branch: 'main' }, { relative: '', kind: 'directory' })).toBeUndefined();
        expect(githubLink(undefined, { relative: '', kind: 'directory' })).toBeUndefined();
    });
});

describe('the items of the menu', () => {
    const ids = (actions: ReturnType<typeof openActions>) => actions.map(action => action.id);
    const labels = (actions: ReturnType<typeof openActions>) => actions.map(action => action.label);

    it('goes, for a folder, Files, editor, file manager, terminal, GitHub, then the copies', () => {
        const actions = openActions({ target: target('', 'directory'), programs: PROGRAMS, git: GIT, inFiles: vi.fn(), effects: effects() });

        expect(labels(actions)).toEqual(['Open in Files', 'Open in Cursor', 'Open in Finder', 'Open in Ghostty', 'Open in GitHub', 'Copy path']);
        expect(actions.map(action => action.group)).toEqual(['open', 'open', 'open', 'open', 'open', 'copy']);
    });

    it('shows a file in its file manager, has no terminal for it, and has both copies', () => {
        const actions = openActions({ target: target('src/index.ts', 'file'), programs: PROGRAMS, git: GIT, effects: effects() });

        expect(labels(actions)).toEqual(['Open in Cursor', 'Show in Finder', 'Open in GitHub', 'Copy path', 'Copy relative path']);
    });

    it('has no relative path for the folder itself, and one for a folder inside it', () => {
        expect(ids(openActions({ target: target('', 'directory'), programs: {}, effects: effects() }))).toEqual(['copyPath']);
        expect(ids(openActions({ target: target('src', 'directory'), programs: {}, effects: effects() }))).toEqual(['copyPath', 'copyRelative']);
    });

    it('has no item for a program that was not found, for Files unless the window can show it, and for GitHub without a page', () => {
        const actions = openActions({ target: target('src', 'directory'), programs: { fileManager: PROGRAMS.fileManager }, git: { remoteUrl: 'git@gitlab.com:acme/app.git', branch: 'main' }, effects: effects() });

        expect(ids(actions)).toEqual(['fileManager', 'copyPath', 'copyRelative']);
    });

    it('turns off what needs the disk when the folder is gone, and keeps the link and the copies', () => {
        const actions = openActions({ target: target('', 'directory'), programs: PROGRAMS, git: GIT, missing: true, inFiles: vi.fn(), effects: effects() });

        expect(actions.map(action => [action.id, action.isDisabled])).toEqual([
            ['files', true],
            ['editor', true],
            ['fileManager', true],
            ['terminal', true],
            ['github', false],
            ['copyPath', false],
        ]);
    });

    it('runs each item against the path, the program and the address it belongs to', () => {
        const done = effects();
        const inFiles = vi.fn();
        const actions = openActions({ target: target('src/index.ts', 'file'), programs: PROGRAMS, git: GIT, inFiles, effects: done });
        const run = (id: string) => actions.find(action => action.id === id)!.run();

        run('files');
        run('editor');
        run('fileManager');
        run('github');
        run('copyPath');
        run('copyRelative');

        expect(inFiles).toHaveBeenCalledOnce();
        expect(done.openPath).toHaveBeenNthCalledWith(1, '/Users/dev/app/src/index.ts', 'editor', PROGRAMS.editor);
        expect(done.openPath).toHaveBeenNthCalledWith(2, '/Users/dev/app/src/index.ts', 'fileManager', PROGRAMS.fileManager);
        expect(done.openUrl).toHaveBeenCalledExactlyOnceWith('https://github.com/acme/app/blob/feature/new-menu/src/index.ts');
        expect(done.copy).toHaveBeenNthCalledWith(1, '/Users/dev/app/src/index.ts');
        expect(done.copy).toHaveBeenNthCalledWith(2, 'src/index.ts');
    });
});
