import { commitScope } from '@clowdy/protocol';
import { describe, expect, it, vi } from 'vitest';

import { FIXTURE_GIT_COMMITS } from '../../daemon/fixtureData';
import { TransportError } from '../../daemon/transport';
import { PlaceFacts } from './gitFacts';
import { baseStateWords, LIST_TEXT, listStateOf } from './listState';
import { PlaceChanges } from './PlaceChanges';

import type { GitBase, GitChangedFile, GitChanges, GitScope, GitStatus } from '@clowdy/protocol';

const KEY = { projectId: 'p1', folderId: 'f1' };
const READY: GitBase = { state: 'ready', name: 'origin/main', commit: '2'.repeat(40), mergeBase: '3'.repeat(40), ahead: 2, behind: 0, commits: FIXTURE_GIT_COMMITS };

const file = (path: string): GitChangedFile => ({ path, kind: 'modified', additions: 1, deletions: 1, revision: 'r' });
const list = (scope: GitScope, files: GitChangedFile[], more: Partial<Extract<GitChanges, { isRepository: true }>> = {}): GitChanges => ({ isRepository: true, scope, files, fileCount: files.length, additions: 0, deletions: 0, statsComplete: true, ...more });

/** A model of a place whose status and list the test gives, read once. */
async function stateOf({ status, changes, scope }: { status: GitStatus; changes: GitChanges | Error | undefined; scope?: GitScope }) {
    const transport = {
        getGitStatus: vi.fn(async () => status),
        getGitChanges: vi.fn(async () => {
            if (changes instanceof Error) throw changes;

            return changes!;
        }),
        getGitFile: vi.fn(),
        getGitViewed: vi.fn(async () => []),
        setGitViewed: vi.fn(),
        clearGitViewed: vi.fn(),
        getGitPullRequest: vi.fn(async () => ({ isRepository: true as const, access: 'ready' as const })),
    };
    const facts = new PlaceFacts(KEY, transport);
    const model = new PlaceChanges(facts, transport);

    await facts.status.refresh();

    if (scope) model.setScope(scope);

    if (changes !== undefined) {
        model.sync(1);
        await new Promise(resolve => setTimeout(resolve, 0));
    }

    return model;
}

const repository = (base: GitBase): GitStatus => ({ isRepository: true, head: { kind: 'branch', name: 'feature', commit: '9'.repeat(40) }, origin: true, entries: [], base });

describe('what the reading area shows', () => {
    it('is loading until the first list has come', async () => {
        const model = await stateOf({ status: repository(READY), changes: undefined });

        expect(listStateOf(model)).toEqual({ kind: 'loading' });
    });

    it('says a folder that is no repository is none, before any list is read', async () => {
        const model = await stateOf({ status: { isRepository: false }, changes: undefined });

        expect(listStateOf(model)).toEqual({ kind: 'notRepository' });
        expect(LIST_TEXT.notRepository).toBe('Not a git repository');
    });

    it('shows the cards when the scope has files', async () => {
        const model = await stateOf({ status: repository(READY), changes: list('all', [file('a.ts'), file('b.ts')], { baseState: 'ready' }) });

        expect(listStateOf(model)).toEqual({ kind: 'files' });
    });

    it('says a failed first read failed, with the reason, and a retry reads again', async () => {
        const model = await stateOf({ status: repository(READY), changes: new TransportError('The daemon answered 503', 503) });

        expect(listStateOf(model)).toEqual({ kind: 'failed', message: 'The daemon answered 503' });
        expect(LIST_TEXT.failed).toBe('Couldn\'t read the changes');
    });

    it('says a clean tree has no changes, and what it is clean against', async () => {
        const model = await stateOf({ status: repository(READY), changes: list('all', [], { baseState: 'ready' }) });

        expect(listStateOf(model)).toEqual({ kind: 'empty', title: 'No changes', description: 'Nothing differs from origin/main' });
    });

    it('says why a scope that is empty is, for each scope', async () => {
        expect(listStateOf(await stateOf({ status: repository(READY), changes: list('branch', [], { baseState: 'ready' }), scope: 'branch' }))).toEqual({ kind: 'empty', title: 'No changes', description: 'Nothing is committed on the branch yet' });
        expect(listStateOf(await stateOf({ status: repository(READY), changes: list('uncommitted', []), scope: 'uncommitted' }))).toEqual({ kind: 'empty', title: 'No changes', description: 'Everything is committed' });

        const sha = FIXTURE_GIT_COMMITS[0]!.sha;

        expect(listStateOf(await stateOf({ status: repository(READY), changes: list(commitScope(sha), []), scope: commitScope(sha) }))).toEqual({ kind: 'empty', title: 'No changes', description: 'This commit changes no files' });
    });

    it('says why there is nothing to compare with, when a branch has no base to be counted against', async () => {
        const noBase = await stateOf({ status: repository({ state: 'no_base' }), changes: list('all', [], { baseState: 'no_base' }) });
        const unborn = await stateOf({ status: repository({ state: 'unborn' }), changes: list('all', [], { baseState: 'unborn' }) });
        const unrelated = await stateOf({ status: repository({ state: 'no_merge_base', name: 'origin/main', commit: '2'.repeat(40) }), changes: list('all', [], { baseState: 'no_merge_base' }) });

        expect(listStateOf(noBase)).toEqual({ kind: 'empty', title: 'No changes', description: 'There is no base branch to compare with yet' });
        expect(listStateOf(unborn)).toEqual({ kind: 'empty', title: 'No changes', description: 'The branch has no commits yet' });
        expect(listStateOf(unrelated)).toEqual({ kind: 'empty', title: 'No changes', description: 'The branch shares no history with its base' });
        expect(baseStateWords('ready')).toBeUndefined();
        expect(baseStateWords(undefined)).toBeUndefined();
    });

    it('says a filter that lets no file through has none to show, and the cards are back when it is cleared', async () => {
        const model = await stateOf({ status: repository(READY), changes: list('all', [file('a.ts')], { baseState: 'ready' }) });

        model.setFilter('*.md');
        expect(listStateOf(model)).toEqual({ kind: 'filtered' });

        model.setFilter('');
        expect(listStateOf(model)).toEqual({ kind: 'files' });
    });

    it('keeps the cards when a later read fails, and does not call the list failed', async () => {
        const answers: Array<GitChanges | Error> = [list('all', [file('a.ts')], { baseState: 'ready' }), new Error('gone')];
        const transport = {
            getGitStatus: vi.fn(async () => repository(READY)),
            getGitChanges: vi.fn(async () => {
                const next = answers.shift()!;

                if (next instanceof Error) throw next;

                return next;
            }),
            getGitFile: vi.fn(),
            getGitViewed: vi.fn(async () => []),
            setGitViewed: vi.fn(),
            clearGitViewed: vi.fn(),
            getGitPullRequest: vi.fn(async () => ({ isRepository: true as const, access: 'ready' as const })),
        };
        const facts = new PlaceFacts(KEY, transport);
        const model = new PlaceChanges(facts, transport);

        await facts.status.refresh();
        model.sync(1);
        await new Promise(resolve => setTimeout(resolve, 0));
        model.sync(2);
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(listStateOf(model)).toEqual({ kind: 'files' });
    });
});
