import { describe, expect, it } from 'vitest';

import { chatWorktreeKey, worktreeCards, worktreeKey } from './worktreeCards';

import type { Chat, ChatWorkspace, FolderWorktrees, ProjectFolder, WorktreeInfo } from '@clowdy/protocol';

const folders: ProjectFolder[] = [
    { id: 'main', path: '/repo' },
    { id: 'api', path: '/api' },
];
const workspace = (path: string, ready = true, folderId = 'main'): ChatWorkspace => ({
    id: path,
    folderId,
    path,
    branch: path.slice(1),
    managed: true,
    ready,
});
const chat = (id: string, rest: Partial<Chat> = {}): Chat => ({
    id,
    projectId: 'p',
    title: id,
    mode: 'autopilot',
    createdAt: 1,
    updatedAt: 1,
    ...rest,
});
const tree = (path: string, rest: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
    path,
    branch: path.slice(1),
    head: 'abcdefg',
    main: false,
    missing: false,
    changes: 0,
    submodules: false,
    managed: false,
    chats: [],
    ...rest,
});
const actual: FolderWorktrees[] = [
    {
        folderId: 'main',
        name: 'repo',
        isRepository: true,
        worktrees: [
            tree('/repo', { main: true }),
            tree('/thread'),
            tree('/archived', { chats: [{ id: 'archive', title: 'Archived', archived: true }] }),
            tree('/external'),
        ],
    },
];

describe('worktree cards', () => {
    it('keeps threads under their root, and considers a tree with only active threads used', () => {
        const root = chat('root');
        const child = chat('thread', { parentChatId: root.id, workspace: workspace('/thread') });
        const cards = worktreeCards([root], [root, child], folders, actual, undefined, []);
        expect(cards.map(card => [card.path, card.used, card.roots.map(root => root.id)])).toEqual([
            ['/thread', true, []],
            ['/archived', false, []],
            ['/external', false, []],
        ]);
    });

    it('keeps both pending and missing root chats without needing an actual Git row', () => {
        const pending = chat('pending', { workspace: workspace('/pending', false) });
        const missing = chat('missing', { workspace: workspace('/missing') });
        const cards = worktreeCards([pending, missing], [pending, missing], folders, [], undefined, []);
        expect(cards.map(card => [card.path, card.pending, card.missing, card.roots.map(root => root.id)])).toEqual([
            ['/pending', true, false, ['pending']],
            ['/missing', false, true, ['missing']],
        ]);
    });

    it('matches Git’s real path to the workspace record through its ID', () => {
        const root = chat('root', { workspace: workspace('/var/tree') });
        const read = [{ ...actual[0], worktrees: [tree('/private/var/tree', { workspaceId: root.workspace!.id })] }];
        const cards = worktreeCards([root], [root], folders, read, undefined, []);
        expect(cards.map(card => [card.path, card.roots.map(root => root.id)])).toEqual([
            ['/private/var/tree', ['root']],
        ]);
        expect(chatWorktreeKey(root, cards)).toBe(worktreeKey('main', '/private/var/tree'));
    });

    it('keeps a newly ordered pending workspace in place when Git reports a canonical path', () => {
        const root = chat('root', { workspace: workspace('/var/tree') });
        const read = [
            {
                ...actual[0],
                worktrees: [tree('/older'), tree('/private/var/tree', { workspaceId: root.workspace!.id })],
            },
        ];
        const cards = worktreeCards([root], [root], folders, read, undefined, [worktreeKey('main', '/var/tree')]);
        expect(cards.map(card => card.path)).toEqual(['/private/var/tree', '/older']);
    });

    it('retains a root whose workspace folder no longer exists in its surviving folder', () => {
        const root = chat('root', { folderId: 'api', workspace: workspace('/lost', true, 'removed') });
        const cards = worktreeCards([root], [root], folders, [], undefined, []);
        expect(cards.map(card => [card.folder.id, card.roots.map(chat => chat.id)])).toEqual([['api', ['root']]]);
    });

    it('moves the card to unused as soon as the last chat is archived, even before the Git read refreshes', () => {
        const archived = chat('archived', { workspace: workspace('/thread'), archivedAt: 1 });
        const read = [
            {
                ...actual[0],
                worktrees: [
                    tree('/thread', {
                        workspaceId: archived.workspace!.id,
                        chats: [{ id: archived.id, title: archived.title, archived: false }],
                    }),
                ],
            },
        ];
        const cards = worktreeCards([], [archived], folders, read, undefined, []);
        expect(cards.map(card => [card.path, card.used])).toEqual([['/thread', false]]);
    });

    it('keeps order when a previously external tree gains a workspace record and a chat', () => {
        const active = chat('active', { workspace: workspace('/external') });
        const cards = worktreeCards([active], [active], folders, actual, undefined, [
            worktreeKey('main', '/external'),
            worktreeKey('main', '/archived'),
        ]);
        expect(cards.map(card => [card.path, card.used])).toEqual([
            ['/external', true],
            ['/archived', false],
            ['/thread', false],
        ]);
    });
});
