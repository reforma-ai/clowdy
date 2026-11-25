import { describe, expect, it } from 'vitest';

import {
    folderViews,
    holdingMarks,
    holdingsLine,
    isWorkspaceSaved,
    missingFolderNote,
    newMainMessage,
    remoteLink,
    removalMessage,
    siteName,
    workspaceFields,
    workspaceFileLines,
    workspacePatch,
} from './projectView';

describe('siteName', () => {
    it('names the sites it knows and gives the host of the others', () => {
        expect(siteName('https://github.com/acme/app')).toBe('GitHub');
        expect(siteName('https://gitlab.com/acme/app')).toBe('GitLab');
        expect(siteName('https://git.example.com:8443/acme/app')).toBe('git.example.com:8443');
    });
});

describe('remoteLink', () => {
    it.each([
        ['git@github.com:acme/app.git', { text: 'github.com/acme/app', href: 'https://github.com/acme/app' }],
        ['github.com:acme/app', { text: 'github.com/acme/app', href: 'https://github.com/acme/app' }],
        ['https://github.com/acme/app.git', { text: 'github.com/acme/app', href: 'https://github.com/acme/app' }],
        ['https://github.com/acme/app/', { text: 'github.com/acme/app', href: 'https://github.com/acme/app' }],
        [
            'ssh://git@gitlab.example.com:2222/team/sub/app.git',
            { text: 'gitlab.example.com/team/sub/app', href: 'https://gitlab.example.com/team/sub/app' },
        ],
        [
            'https://git.example.com:8443/acme/app.git',
            { text: 'git.example.com:8443/acme/app', href: 'https://git.example.com:8443/acme/app' },
        ],
    ])('links %s', (remote, expected) => {
        expect(remoteLink(remote)).toEqual(expected);
    });

    it('drops credentials from the text and the link', () => {
        expect(remoteLink('https://octocat:ghp_secret@github.com/acme/app.git')).toEqual({
            text: 'github.com/acme/app',
            href: 'https://github.com/acme/app',
        });
        expect(remoteLink('http://octocat:secret@intranet.example.com/acme/app.git')).toEqual({
            text: 'http://intranet.example.com/acme/app.git',
        });
    });

    it('drops credentials from an address that does not parse too', () => {
        expect(remoteLink('https://octocat:ghp_secret@github.com:abc/acme/app.git')).toEqual({
            text: 'https://github.com:abc/acme/app.git',
        });
        expect(remoteLink('ssh://deploy:hunter2@build host/acme/app.git')?.text).not.toContain('hunter2');
        expect(remoteLink('https://octocat:ghp_secret@github.com:abc/acme/app.git')?.href).toBeUndefined();
    });

    it.each([
        ['/Users/me/repos/app.git'],
        ['C:\\repos\\app.git'],
        ['file:///srv/git/app.git'],
        ['git@intranet:acme/app.git'],
    ])('shows %s without a link', remote => {
        expect(remoteLink(remote)?.href).toBeUndefined();
    });

    it('has nothing to show for an empty remote', () => {
        expect(remoteLink(undefined)).toBeUndefined();
        expect(remoteLink('  ')).toBeUndefined();
    });
});

describe('holdingsLine', () => {
    it('counts chats and tasks, with the right plural', () => {
        expect(holdingsLine({ chats: 12, tasks: 5 })).toBe('12 chats, 5 tasks');
        expect(holdingsLine({ chats: 1, tasks: 1 })).toBe('1 chat, 1 task');
        expect(holdingsLine({ chats: 0, tasks: 0 })).toBe('No chats or tasks yet');
        expect(holdingsLine(undefined)).toBeUndefined();
    });
});

describe('holdingMarks', () => {
    it('counts chats and tasks as marks, leaving out a count of none', () => {
        expect(holdingMarks({ chats: 12, tasks: 1 })).toEqual(['12 chats', '1 task']);
        expect(holdingMarks({ chats: 0, tasks: 3 })).toEqual(['3 tasks']);
        expect(holdingMarks({ chats: 0, tasks: 0 })).toEqual([]);
        expect(holdingMarks(undefined)).toEqual([]);
    });
});

describe('removalMessage', () => {
    it('says what goes and what stays', () => {
        expect(removalMessage('Car Rental', ['/Users/dev/car-rental'], { chats: 4, tasks: 11 })).toBe(
            '"Car Rental" leaves Clowdy together with its 4 chats and 11 tasks, and the work of its agents, for good. The folder /Users/dev/car-rental and everything in it stay on your computer.'
        );
        expect(removalMessage('Car Rental', ['/x'], undefined)).toContain('its chats and tasks, and the work');
    });

    it('counts the folders that stay when there are several', () => {
        expect(removalMessage('Car Rental', ['/a', '/b'], undefined)).toContain(
            'Its 2 folders and everything in them stay on your computer.'
        );
    });
});

describe('folderViews', () => {
    const project = {
        folders: [
            { id: 'fld_a', path: '/work/app' },
            { id: 'fld_b', path: '/other/app' },
            { id: 'fld_c', path: '/work/api' },
        ],
    };

    it('names each folder, marks the first as main, and reads what the daemon knows of each by its id', () => {
        const views = folderViews(project, {
            folders: [
                { folderId: 'fld_c', exists: false, chats: 0 },
                { folderId: 'fld_a', exists: true, remoteUrl: 'git@github.com:acme/app.git', chats: 0 },
                { folderId: 'fld_b', exists: true, remoteUrl: '/srv/git/app.git', chats: 0 },
            ],
        });

        expect(views.map(view => [view.name, view.isMain, view.missing, view.remote])).toEqual([
            ['app', true, false, { text: 'github.com/acme/app', href: 'https://github.com/acme/app' }],
            ['app-2', false, false, { text: '/srv/git/app.git' }],
            ['api', false, true, undefined],
        ]);
    });

    it('calls no folder missing before the folders have been read', () => {
        expect(folderViews(project, undefined).map(view => view.missing)).toEqual([false, false, false]);
        expect(folderViews(project, { folders: [] }).every(view => !view.missing && !view.remote)).toBe(true);
    });
});

describe('missingFolderNote', () => {
    it('says the agents cannot work without the main folder, and that another one is left out', () => {
        expect(missingFolderNote({}, true)).toBe(
            'This folder no longer exists, so the agents of this project cannot work. If it moved, locate its new place.'
        );
        expect(missingFolderNote({}, false)).toBe('This folder no longer exists, so the agents leave it out');
        expect(missingFolderNote({ personal: true }, true)).toContain('Clowdy makes it again');
    });
});

describe('newMainMessage', () => {
    it('says where the agents work from now on, that nothing moves, and what the agents lose', () => {
        expect(newMainMessage('Car Rental', '/work/api')).toBe(
            'Car Rental will work in /work/api from now on. Nothing is moved or copied. An agent that worked in the old main folder starts a new conversation, so what it remembered may not carry over.'
        );
    });

    it('says that a removed main folder leaves the project and stays on disk', () => {
        expect(newMainMessage('Car Rental', '/work/api', '/work/app')).toBe(
            'Car Rental will work in /work/api from now on, and /work/app leaves the project. Nothing is moved, copied or deleted. An agent that worked in the old main folder starts a new conversation, so what it remembered may not carry over.'
        );
    });
});

describe('the Workspace fields of a folder', () => {
    it('shows no settings as empty fields and a setup as its lines', () => {
        expect(workspaceFields(undefined)).toEqual({ baseBranch: '', files: '', command: '' });
        expect(
            workspaceFields({
                baseBranch: 'origin/next',
                setup: { files: ['.env', '.env*'], command: 'bun install\nbun run build' },
            })
        ).toEqual({ baseBranch: 'origin/next', files: '.env\n.env*', command: 'bun install\nbun run build' });
        expect(workspaceFields({ setup: { files: [] } })).toEqual({ baseBranch: '', files: '', command: '' });
    });

    it('reads the files field line by line: trimmed, with the empty lines and the line endings of a pasted list left out', () => {
        expect(workspaceFileLines('  .env \r\n\n.env.local\n   \n')).toEqual(['.env', '.env.local']);
        expect(workspaceFileLines('')).toEqual([]);
    });

    it('reads a path typed the Windows way, or with a leading ./, as the daemon takes it, and leaves a path that goes up for the daemon to refuse', () => {
        expect(workspaceFileLines('apps\\web\\.env\n./.env.local\n.\\.npmrc\n././x')).toEqual([
            'apps/web/.env',
            '.env.local',
            '.npmrc',
            'x',
        ]);
        expect(workspaceFileLines('../secrets\n./')).toEqual(['../secrets']);
        expect(workspaceFileLines('C:\\code\\.env')).toEqual(['C:/code/.env']);
    });

    it('sends what is typed, trimmed, and null for a field with nothing in it', () => {
        expect(workspacePatch({ baseBranch: '  next ', files: '.env\n', command: ' bun install ' })).toEqual({
            baseBranch: 'next',
            setup: { files: ['.env'], command: 'bun install' },
        });
        expect(workspacePatch({ baseBranch: '', files: '', command: '' })).toEqual({ baseBranch: null, setup: null });
        expect(workspacePatch({ baseBranch: ' ', files: ' \n ', command: '\n' })).toEqual({
            baseBranch: null,
            setup: null,
        });
        expect(workspacePatch({ baseBranch: '', files: '', command: 'make' })).toEqual({
            baseBranch: null,
            setup: { files: [], command: 'make' },
        });
        expect(workspacePatch({ baseBranch: '', files: '.env', command: '' })).toEqual({
            baseBranch: null,
            setup: { files: ['.env'] },
        });
    });

    it('tells whether saving the fields would change anything', () => {
        const settings = { baseBranch: 'next', setup: { files: ['.env'], command: 'make' } };

        expect(isWorkspaceSaved(workspaceFields(settings), settings)).toBe(true);
        expect(isWorkspaceSaved({ baseBranch: ' next', files: '.env\n\n', command: 'make ' }, settings)).toBe(true);
        expect(isWorkspaceSaved({ baseBranch: '', files: '', command: '' }, undefined)).toBe(true);
        expect(isWorkspaceSaved({ baseBranch: 'dev', files: '.env', command: 'make' }, settings)).toBe(false);
        expect(isWorkspaceSaved({ baseBranch: 'next', files: '.env\n.npmrc', command: 'make' }, settings)).toBe(false);
        expect(isWorkspaceSaved({ baseBranch: 'next', files: '.env', command: '' }, settings)).toBe(false);
        expect(isWorkspaceSaved({ baseBranch: 'next', files: '', command: '' }, undefined)).toBe(false);
    });
});
