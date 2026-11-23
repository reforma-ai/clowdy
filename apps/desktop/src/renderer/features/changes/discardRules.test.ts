import { describe, expect, it } from 'vitest';

import { agentsWorkingIn, agentsWorkingWords, discardableFiles, discardWords } from './discardRules';

import type { Chat, GitChangedFile, GitChanges, Run } from '@clowdy/protocol';

const file = (path: string, more: Partial<GitChangedFile> = {}): GitChangedFile => ({
    path,
    kind: 'modified',
    revision: `100644:${'1'.repeat(40)}:100644:${'2'.repeat(40)}`,
    ...more,
});

const listOf = (files: GitChangedFile[]): Extract<GitChanges, { isRepository: true }> => ({
    isRepository: true,
    scope: 'uncommitted',
    files,
    fileCount: files.length,
    additions: 0,
    deletions: 0,
    statsComplete: true,
});

describe('discardableFiles', () => {
    const uncommitted = listOf([
        file('a.ts'),
        file('new.ts', { kind: 'added', untracked: true }),
        file('gone.ts', { kind: 'deleted' }),
    ]);

    it('offers the uncommitted files in the scopes that list them, as their uncommitted entries, and in no other', () => {
        for (const scope of ['all', 'uncommitted'] as const) {
            expect([...discardableFiles(scope, uncommitted).keys()]).toEqual(['a.ts', 'new.ts', 'gone.ts']);
        }

        expect(discardableFiles('all', uncommitted).get('new.ts')).toMatchObject({ kind: 'added', untracked: true });

        for (const scope of ['branch', `commit:${'a'.repeat(40)}`] as const) {
            expect(discardableFiles(scope, uncommitted).size).toBe(0);
        }
    });

    it('offers nothing before the uncommitted files have been read', () => {
        expect(discardableFiles('all', undefined).size).toBe(0);
    });

    it('leaves out a file with merge conflicts and a submodule, which the daemon refuses', () => {
        const submodule = file('vendor/sub', { revision: `160000:${'3'.repeat(40)}:160000:${'4'.repeat(40)}` });
        const added = file('vendor/new-sub', {
            kind: 'added',
            revision: `000000:${'0'.repeat(40)}:160000:${'4'.repeat(40)}`,
        });
        const list = listOf([file('a.ts'), file('both.ts', { kind: 'conflicted' }), submodule, added]);

        expect([...discardableFiles('all', list).keys()]).toEqual(['a.ts']);
    });
});

describe('discardWords', () => {
    it('says a tracked file goes back to the last commit and that a copy of what it holds now is kept for 7 days', () => {
        expect(discardWords(file('src/booking/price.ts'))).toEqual({
            title: 'Discard changes to price.ts?',
            body: 'The file goes back to the last commit. A copy of what it holds now is kept for 7 days.',
        });
        expect(discardWords(file('src/limits.ts', { kind: 'typechange' })).body).toBe(
            'The file goes back to the last commit. A copy of what it holds now is kept for 7 days.'
        );
    });

    it('says a file that is not in git is deleted, with its copy kept, in the words GitHub Desktop has for it', () => {
        expect(discardWords(file('notes.md', { kind: 'added', untracked: true }))).toEqual({
            title: 'Delete notes.md?',
            body: 'The file is not in git. A copy of it is kept for 7 days.',
        });
    });

    it('says a file that was added but never committed is deleted', () => {
        expect(discardWords(file('src/new.ts', { kind: 'added' }))).toEqual({
            title: 'Delete new.ts?',
            body: 'The file was never committed. A copy of it is kept for 7 days.',
        });
    });

    it('says a rename is undone, and promises no copy for a file that is gone from the disk', () => {
        expect(discardWords(file('src/new-name.ts', { kind: 'renamed', oldPath: 'src/old-name.ts' }))).toEqual({
            title: 'Discard changes to new-name.ts?',
            body: 'The rename is undone and the file goes back to the last commit. A copy of what it holds now is kept for 7 days.',
        });
        expect(discardWords(file('src/gone.ts', { kind: 'deleted' }))).toEqual({
            title: 'Discard changes to gone.ts?',
            body: 'The file comes back from the last commit',
        });
    });

    it('closes a text of two sentences with a period and one of a single phrase with none', () => {
        for (const kind of ['modified', 'added', 'deleted', 'renamed', 'typechange'] as const) {
            for (const untracked of [undefined, true as const]) {
                const { title, body } = discardWords(file('a.ts', { kind, ...(untracked && { untracked }) }));
                const sentences = body.split('. ').length;

                expect(title.endsWith('?')).toBe(true);
                expect(body.endsWith('.')).toBe(sentences > 1);
            }
        }
    });
});

describe('agentsWorkingWords', () => {
    it('says nothing for none, and an agent or how many for the others, as a phrase with no period', () => {
        expect(agentsWorkingWords(0)).toBeUndefined();
        expect(agentsWorkingWords(1)).toBe('An agent is working here');
        expect(agentsWorkingWords(3)).toBe('3 agents are working here');
    });
});

describe('agentsWorkingIn', () => {
    const folder = { id: 'fld_1', path: '/work/app' };
    const worktree = {
        id: 'wks_1',
        folderId: 'fld_1',
        path: '/work/app-tree',
        branch: 'chat/1',
        managed: true,
        ready: true,
    };
    const chatOf = (id: string, more: Partial<Chat> = {}) =>
        ({ id, projectId: 'prj_1', folderId: 'fld_1', orchestratorRunId: `run_${id}`, ...more }) as unknown as Chat;
    const runOf = (id: string, status: Run['status']) => ({ id: `run_${id}`, status }) as unknown as Run;
    const project = (chats: Chat[], runs: Run[]) => ({
        chats: new Map(chats.map(chat => [chat.id, chat])),
        runs: new Map(runs.map(run => [run.id, run])),
        project: { folders: [folder] },
    });

    it('counts the chats that write in the place: a run that is going, or that keeps background work going, in the worktree or the checkout it names', () => {
        const state = project(
            [
                chatOf('a', { workspace: worktree }),
                chatOf('b', { workspace: worktree }),
                chatOf('c'),
                chatOf('d', { workspace: worktree }),
                chatOf('e', { workspace: worktree }),
            ],
            [
                runOf('a', 'running'),
                runOf('b', 'waiting_background'),
                runOf('c', 'running'),
                runOf('d', 'succeeded'),
                runOf('e', 'waiting_user'),
            ]
        );

        expect(agentsWorkingIn(state, { folderId: 'fld_1', workspaceId: 'wks_1' })).toBe(2);
        // The folder's own checkout is another place: only the chat that has no worktree works in it.
        expect(agentsWorkingIn(state, { folderId: 'fld_1' })).toBe(1);
        expect(agentsWorkingIn(state, { folderId: 'fld_other' })).toBe(0);
    });

    it('counts none for a queued run, a chat that never ran and a project with no chat', () => {
        const state = project(
            [chatOf('a', { workspace: worktree }), chatOf('b', { workspace: worktree, orchestratorRunId: undefined })],
            [runOf('a', 'queued')]
        );

        expect(agentsWorkingIn(state, { folderId: 'fld_1', workspaceId: 'wks_1' })).toBe(0);
        expect(agentsWorkingIn(project([], []), { folderId: 'fld_1' })).toBe(0);
    });
});
