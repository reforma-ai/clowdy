import { describe, expect, it } from 'vitest';

import {
    COMMIT_FIRST,
    chatsWorkingInCheckout,
    currentBranchOf,
    mainBranchBlock,
    mainBranchOptions,
} from './mainBranch';

import type { Chat, GitStatus, ProjectFolder, Run } from '@clowdy/protocol';
import type { BranchListing } from '../changes/branchChoices';

const folders: ProjectFolder[] = [
    { id: 'fld_main', path: '/work/app' },
    { id: 'fld_api', path: '/work/api' },
];

const chat = (id: string, rest: Partial<Chat> = {}): Chat => ({
    id,
    projectId: 'p',
    title: id,
    mode: 'autopilot',
    createdAt: 1,
    updatedAt: 1,
    ...rest,
});
const run = (id: string, status: Run['status']): Run => ({ id, status }) as Run;

describe("the chats that work in the folder's checkout", () => {
    const runs = new Map<string, Run>([
        ['run_a', run('run_a', 'running')],
        ['run_b', run('run_b', 'waiting_user')],
        ['run_c', run('run_c', 'waiting_background')],
        ['run_d', run('run_d', 'succeeded')],
        ['run_e', run('run_e', 'queued')],
    ]);

    it('are the ones whose orchestrator has not ended, in any state the daemon counts: queued, running, waiting for the person or for background work', () => {
        const chats = [
            chat('a', { orchestratorRunId: 'run_a' }),
            chat('b', { orchestratorRunId: 'run_b' }),
            chat('c', { orchestratorRunId: 'run_c' }),
            chat('d', { orchestratorRunId: 'run_d' }),
            chat('e', { orchestratorRunId: 'run_e' }),
            chat('none'),
        ];

        expect(chatsWorkingInCheckout(chats, runs, folders, 'fld_main')).toBe(4);
    });

    it('are those of the folder the chat works in: one with no folder follows the main folder, one that names another is that folder, one in a worktree is neither', () => {
        const chats = [
            chat('main', { orchestratorRunId: 'run_a' }),
            chat('api', { orchestratorRunId: 'run_b', folderId: 'fld_api' }),
            chat('gone', { orchestratorRunId: 'run_c', folderId: 'fld_removed' }),
            chat('tree', {
                orchestratorRunId: 'run_e',
                workspace: { id: 'wks_1', folderId: 'fld_main', path: '/w/tree', managed: true, ready: true },
            }),
        ];

        // A folder the project no longer has was handed back to the main folder.
        expect(chatsWorkingInCheckout(chats, runs, folders, 'fld_main')).toBe(2);
        expect(chatsWorkingInCheckout(chats, runs, folders, 'fld_api')).toBe(1);
    });

    it('count a thread as a chat of its own, and a run the window has not heard of as none', () => {
        const chats = [
            chat('parent', { orchestratorRunId: 'run_a' }),
            chat('thread', { orchestratorRunId: 'run_b', parentChatId: 'parent' }),
            chat('unheard', { orchestratorRunId: 'run_unknown' }),
        ];

        expect(chatsWorkingInCheckout(chats, runs, folders, 'fld_main')).toBe(2);
    });
});

describe('what is in the way of a switch, as far as the window knows', () => {
    const dirty = (paths: number, truncated = false): GitStatus => ({
        isRepository: true,
        head: { kind: 'branch', name: 'main', commit: 'a'.repeat(40) },
        origin: true,
        entries: Array.from({ length: paths }, (_, index) => ({
            path: `f${index}.ts`,
            unstaged: 'modified' as const,
        })),
        ...(truncated && { truncated: true as const }),
        base: { state: 'unborn' },
    });

    it('is a tree with changes, in the words of the daemon, with how many files', () => {
        expect(mainBranchBlock(0, dirty(3))).toEqual({ message: COMMIT_FIRST, hint: '3 files changed' });
        expect(mainBranchBlock(0, dirty(1))).toEqual({ message: COMMIT_FIRST, hint: '1 file changed' });
        expect(COMMIT_FIRST).toBe('Commit or discard the changes first');
    });

    it('counts a list that was cut as at least that many', () => {
        expect(mainBranchBlock(0, dirty(300, true))).toEqual({ message: COMMIT_FIRST, hint: '300+ files changed' });
    });

    it('is the chats that work in the folder, the first thing the daemon says, ahead of the tree', () => {
        expect(mainBranchBlock(1, dirty(3))).toEqual({
            message: '1 chat is working here',
            hint: 'Stop them or wait until they finish',
        });
        expect(mainBranchBlock(2, undefined)).toEqual({
            message: '2 chats are working here',
            hint: 'Stop them or wait until they finish',
        });
    });

    it('is nothing for a clean tree, a status that was not read and a folder that is no repository', () => {
        expect(mainBranchBlock(0, dirty(0))).toBeUndefined();
        expect(mainBranchBlock(0, undefined)).toBeUndefined();
        expect(mainBranchBlock(0, { isRepository: false })).toBeUndefined();
    });
});

describe("the rows of the pill's list", () => {
    const listing: BranchListing = {
        isRepository: true,
        defaultBranch: 'main',
        local: [
            { name: 'main', current: true, default: true },
            { name: 'dev' },
            { name: 'held', heldBy: { path: '/work/app-held' } },
        ],
        remote: [{ name: 'feature/search' }],
        recent: ['dev'],
    };

    it("are the Changes sidebar's: Default, Recent, Local and Remote, a branch that another worktree holds dimmed with where", () => {
        const options = mainBranchOptions(listing, undefined, undefined);

        expect(options.map(option => [option.group, option.id, option.isDisabled ?? false])).toEqual([
            ['Default', 'main', false],
            ['Recent', 'dev', false],
            ['Local', 'held', true],
            ['Remote', 'feature/search', false],
        ]);
        expect(options.find(option => option.id === 'held')?.description).toBe('Checked out in /work/app-held');
    });

    it("dim every branch but the folder's own while something is in the way, and keep where a held one is", () => {
        const options = mainBranchOptions(listing, { message: COMMIT_FIRST }, undefined);

        expect(options.map(option => [option.id, option.isDisabled ?? false])).toEqual([
            ['main', false],
            ['dev', true],
            ['held', true],
            ['feature/search', true],
        ]);
        expect(options.find(option => option.id === 'held')?.description).toBe('Checked out in /work/app-held');
    });

    it('are all dimmed on a detached HEAD, which is on no branch', () => {
        const detached: BranchListing = {
            ...listing,
            local: listing.local.map(({ current: _current, ...rest }) => rest),
        };

        expect(currentBranchOf(detached)).toBeUndefined();
        expect(
            mainBranchOptions(detached, { message: COMMIT_FIRST }, undefined).every(option => option.isDisabled)
        ).toBe(true);
    });

    it('say which branch the folder is on', () => {
        expect(currentBranchOf(listing)).toBe('main');
    });
});
