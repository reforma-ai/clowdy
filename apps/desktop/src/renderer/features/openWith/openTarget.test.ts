import { describe, expect, it, vi } from 'vitest';

import {
    absolutePath,
    compareLink,
    type FolderGit,
    githubLink,
    type OpenEffects,
    type OpenTarget,
    openActions,
} from './openTarget';

const GIT: FolderGit = { remoteUrl: 'git@github.com:acme/app.git', branch: 'feature/new-menu' };
const FOLDER = { id: 'fld_app', path: '/Users/dev/app' };
const target = (relative: string, kind: OpenTarget['kind']): OpenTarget => ({
    projectId: 'p-app',
    folder: FOLDER,
    path: absolutePath(FOLDER.path, relative),
    relative,
    kind,
});

const PROGRAMS = {
    fileManager: { id: 'finder', name: 'Finder' },
    editor: { id: 'cursor', name: 'Cursor' },
    terminal: { id: 'ghostty', name: 'Ghostty' },
};

function effects(): OpenEffects {
    return { openPath: vi.fn(), openUrl: vi.fn(), copy: vi.fn() };
}

describe('where a path is on the disk', () => {
    it("joins a folder and a path inside it with the folder's own separator", () => {
        expect(absolutePath('/Users/dev/app', 'src/index.ts')).toBe('/Users/dev/app/src/index.ts');
        expect(absolutePath('/Users/dev/app/', 'src')).toBe('/Users/dev/app/src');
        expect(absolutePath('C:\\Users\\dev\\app', 'src/index.ts')).toBe('C:\\Users\\dev\\app\\src\\index.ts');
        expect(absolutePath('/Users/dev/app', '')).toBe('/Users/dev/app');
    });
});

describe('the page on GitHub', () => {
    it('is the repository for the folder itself, whatever branch is checked out', () => {
        expect(githubLink(GIT, { relative: '', kind: 'directory' })).toBe('https://github.com/acme/app');
        expect(githubLink({ remoteUrl: 'https://github.com/acme/app.git' }, { relative: '', kind: 'directory' })).toBe(
            'https://github.com/acme/app'
        );
    });

    it('is the file on the branch that is checked out, and a folder in it a tree of that branch, each part made safe for an address', () => {
        expect(githubLink(GIT, { relative: 'src/index.ts', kind: 'file' })).toBe(
            'https://github.com/acme/app/blob/feature/new-menu/src/index.ts'
        );
        expect(githubLink(GIT, { relative: 'src/menu', kind: 'directory' })).toBe(
            'https://github.com/acme/app/tree/feature/new-menu/src/menu'
        );
        expect(githubLink(GIT, { relative: 'docs/my notes#1.md', kind: 'file' })).toBe(
            'https://github.com/acme/app/blob/feature/new-menu/docs/my%20notes%231.md'
        );
    });

    it('names the short hash on a detached HEAD', () => {
        expect(githubLink({ ...GIT, branch: 'a1b2c3d', detached: true }, { relative: 'README.md', kind: 'file' })).toBe(
            'https://github.com/acme/app/blob/a1b2c3d/README.md'
        );
    });

    it('is nothing for a file without a branch to name, for another host, and for no remote', () => {
        expect(githubLink({ remoteUrl: GIT.remoteUrl }, { relative: 'README.md', kind: 'file' })).toBeUndefined();
        expect(
            githubLink(
                { remoteUrl: 'git@gitlab.com:acme/app.git', branch: 'main' },
                { relative: '', kind: 'directory' }
            )
        ).toBeUndefined();
        expect(
            githubLink({ remoteUrl: '/srv/git/app.git', branch: 'main' }, { relative: '', kind: 'directory' })
        ).toBeUndefined();
        expect(githubLink({ branch: 'main' }, { relative: '', kind: 'directory' })).toBeUndefined();
        expect(githubLink(undefined, { relative: '', kind: 'directory' })).toBeUndefined();
    });
});

describe('the compare page on GitHub', () => {
    const PAGE = 'https://github.com/acme/app/compare';

    it('is the branch against its base on the repository of origin, with the page opened to start the pull request', () => {
        expect(compareLink(GIT, { head: 'feature/new-menu', base: 'main' })).toBe(
            `${PAGE}/main...feature/new-menu?expand=1`
        );
        expect(compareLink({ remoteUrl: 'https://github.com/acme/app.git' }, { head: 'fix', base: 'main' })).toBe(
            `${PAGE}/main...fix?expand=1`
        );
        expect(compareLink({ remoteUrl: 'ssh://git@github.com/acme/app.git' }, { head: 'fix', base: 'develop' })).toBe(
            `${PAGE}/develop...fix?expand=1`
        );
    });

    it('leaves the base to the page when there is none', () => {
        expect(compareLink(GIT, { head: 'feature/new-menu' })).toBe(`${PAGE}/feature/new-menu?expand=1`);
        expect(compareLink(GIT, { head: 'fix', base: '' })).toBe(`${PAGE}/fix?expand=1`);
    });

    it('makes each part of a name safe for an address and keeps the slashes inside it', () => {
        expect(compareLink(GIT, { head: 'dana/fix #12 (50%)?', base: 'release/2.0' })).toBe(
            `${PAGE}/release/2.0...dana/fix%20%2312%20(50%25)%3F?expand=1`
        );
        expect(compareLink(GIT, { head: 'feat/ünï', base: 'main' })).toBe(`${PAGE}/main...feat/%C3%BCn%C3%AF?expand=1`);
        expect(compareLink(GIT, { head: 'a&b=c', base: 'x?y' })).toBe(`${PAGE}/x%3Fy...a%26b%3Dc?expand=1`);
    });

    it('never has the credential a remote carries, whatever the form of it', () => {
        for (const remoteUrl of [
            'https://octocat:ghp_s3cret@github.com/acme/app.git',
            'https://ghp_s3cret@github.com/acme/app',
            'ssh://octocat:s3cret@github.com/acme/app.git',
        ]) {
            const link = compareLink({ remoteUrl }, { head: 'fix', base: 'main' });

            expect(link).toBe(`${PAGE}/main...fix?expand=1`);
            expect(link).not.toMatch(/s3cret|octocat/);
        }
    });

    it("takes GitHub's ssh over port 443 for GitHub", () => {
        expect(
            compareLink({ remoteUrl: 'ssh://git@ssh.github.com:443/acme/app.git' }, { head: 'fix', base: 'main' })
        ).toBe(`${PAGE}/main...fix?expand=1`);
    });

    it('is the page of a GitHub Enterprise server only when the caller says it is one, with its port', () => {
        const enterprise = { remoteUrl: 'git@ghe.example.com:team/service.git' };

        expect(compareLink(enterprise, { head: 'fix', base: 'main' })).toBeUndefined();
        expect(compareLink(enterprise, { head: 'fix', base: 'main' }, 'ghe.example.com')).toBe(
            'https://ghe.example.com/team/service/compare/main...fix?expand=1'
        );
        expect(compareLink(enterprise, { head: 'fix', base: 'main' }, 'GHE.example.com')).toBe(
            'https://ghe.example.com/team/service/compare/main...fix?expand=1'
        );
        expect(compareLink(enterprise, { head: 'fix', base: 'main' }, 'other.example.com')).toBeUndefined();
        expect(
            compareLink(
                { remoteUrl: 'https://ghe.example.com:8443/team/service.git' },
                { head: 'fix', base: 'main' },
                'ghe.example.com:8443'
            )
        ).toBe('https://ghe.example.com:8443/team/service/compare/main...fix?expand=1');
        // Enterprise at the host is not the host without its port.
        expect(
            compareLink(
                { remoteUrl: 'https://ghe.example.com:8443/team/service.git' },
                { head: 'fix', base: 'main' },
                'ghe.example.com'
            )
        ).toBeUndefined();
    });

    it('is nothing for another site, a remote that is no web address, no remote, and no branch', () => {
        expect(
            compareLink({ remoteUrl: 'git@gitlab.com:acme/app.git' }, { head: 'fix', base: 'main' })
        ).toBeUndefined();
        expect(compareLink({ remoteUrl: '/srv/git/app.git' }, { head: 'fix', base: 'main' })).toBeUndefined();
        expect(
            compareLink({ remoteUrl: 'http://octocat:s3cret@github.com/acme/app.git' }, { head: 'fix', base: 'main' })
        ).toBeUndefined();
        expect(compareLink({ branch: 'main' }, { head: 'fix', base: 'main' })).toBeUndefined();
        expect(compareLink(undefined, { head: 'fix', base: 'main' })).toBeUndefined();
        expect(compareLink(GIT, { head: '', base: 'main' })).toBeUndefined();
    });
});

describe('the items of the menu', () => {
    const ids = (actions: ReturnType<typeof openActions>) => actions.map(action => action.id);
    const labels = (actions: ReturnType<typeof openActions>) => actions.map(action => action.label);

    it('goes, for a folder, Files, Terminal and the copy, which the app does itself, then what leaves the app: editor, file manager, terminal program, GitHub', () => {
        const actions = openActions({
            target: target('', 'directory'),
            programs: PROGRAMS,
            git: GIT,
            inFiles: vi.fn(),
            inTerminal: vi.fn(),
            effects: effects(),
        });

        expect(labels(actions)).toEqual([
            'Open in Files',
            'Open in Terminal',
            'Copy path',
            'Open in Cursor',
            'Open in Finder',
            'Open in Ghostty',
            'Open in GitHub',
        ]);
        expect(actions.map(action => action.group)).toEqual([
            'inside',
            'inside',
            'copy',
            'outside',
            'outside',
            'outside',
            'outside',
        ]);
    });

    it('shows a file in its file manager, has no terminal of either kind for it, and has both copies', () => {
        const actions = openActions({
            target: target('src/index.ts', 'file'),
            programs: PROGRAMS,
            git: GIT,
            inFiles: vi.fn(),
            inTerminal: vi.fn(),
            effects: effects(),
        });

        expect(labels(actions)).toEqual([
            'Open in Files',
            'Copy path',
            'Copy relative path',
            'Open in Cursor',
            'Show in Finder',
            'Open in GitHub',
        ]);
    });

    it('has no relative path for the folder itself, and one for a folder inside it', () => {
        expect(ids(openActions({ target: target('', 'directory'), programs: {}, effects: effects() }))).toEqual([
            'copyPath',
        ]);
        expect(ids(openActions({ target: target('src', 'directory'), programs: {}, effects: effects() }))).toEqual([
            'copyPath',
            'copyRelative',
        ]);
    });

    it('has no item for a program that was not found, for Files or Terminal unless the window can show them, and for GitHub without a page', () => {
        const actions = openActions({
            target: target('src', 'directory'),
            programs: { fileManager: PROGRAMS.fileManager },
            git: { remoteUrl: 'git@gitlab.com:acme/app.git', branch: 'main' },
            effects: effects(),
        });

        expect(ids(actions)).toEqual(['copyPath', 'copyRelative', 'fileManager']);
    });

    it('turns off what needs the disk when the folder is gone, and keeps the link and the copies', () => {
        const actions = openActions({
            target: target('', 'directory'),
            programs: PROGRAMS,
            git: GIT,
            missing: true,
            inFiles: vi.fn(),
            inTerminal: vi.fn(),
            effects: effects(),
        });

        expect(actions.map(action => [action.id, action.isDisabled])).toEqual([
            ['files', true],
            ['terminal', true],
            ['copyPath', false],
            ['editor', true],
            ['fileManager', true],
            ['terminalApp', true],
            ['github', false],
        ]);
    });

    it('runs each item against the path, the program and the address it belongs to', () => {
        const done = effects();
        const inFiles = vi.fn();
        const inTerminal = vi.fn();
        const actions = openActions({
            target: target('src', 'directory'),
            programs: PROGRAMS,
            git: GIT,
            inFiles,
            inTerminal,
            effects: done,
        });
        const run = (id: string) => actions.find(action => action.id === id)!.run();

        run('files');
        run('terminal');
        run('editor');
        run('fileManager');
        run('terminalApp');
        run('github');
        run('copyPath');
        run('copyRelative');

        expect(inFiles).toHaveBeenCalledOnce();
        expect(inTerminal).toHaveBeenCalledOnce();
        expect(done.openPath).toHaveBeenNthCalledWith(1, '/Users/dev/app/src', 'editor', PROGRAMS.editor);
        expect(done.openPath).toHaveBeenNthCalledWith(2, '/Users/dev/app/src', 'fileManager', PROGRAMS.fileManager);
        expect(done.openPath).toHaveBeenNthCalledWith(3, '/Users/dev/app/src', 'terminal', PROGRAMS.terminal);
        expect(done.openUrl).toHaveBeenCalledExactlyOnceWith('https://github.com/acme/app/tree/feature/new-menu/src');
        expect(done.copy).toHaveBeenNthCalledWith(1, '/Users/dev/app/src');
        expect(done.copy).toHaveBeenNthCalledWith(2, 'src');
    });
});
