import { commitScope, turnScope } from '@clowdy/protocol';
import { runInAction } from 'mobx';
import { describe, expect, it, vi } from 'vitest';

import { FIXTURE_GIT_COMMITS } from '../../daemon/fixtureData';
import { TransportError } from '../../daemon/transport';
import { PlaceFacts } from './gitFacts';
import { listStateOf } from './listState';
import { PlaceChanges, placeChangesOf, type RepositoryChanges } from './PlaceChanges';

import type {
    GitBase,
    GitChangedFile,
    GitChanges,
    GitFileSides,
    GitScope,
    GitStatus,
    GitViewedMark,
} from '@clowdy/protocol';

const KEY = { projectId: 'p1', folderId: 'f1', workspaceId: 'w1' };
const NEWEST = FIXTURE_GIT_COMMITS[0]!;
const OLDEST = FIXTURE_GIT_COMMITS[1]!;

const file = (path: string, revision = 'r1', more: Partial<GitChangedFile> = {}): GitChangedFile => ({
    path,
    kind: 'modified',
    additions: 1,
    deletions: 1,
    revision,
    ...more,
});

const list = (scope: GitScope, files: GitChangedFile[], more: Partial<RepositoryChanges> = {}): GitChanges => ({
    isRepository: true,
    scope,
    from: 'f'.repeat(40),
    files,
    fileCount: files.length,
    additions: files.length,
    deletions: files.length,
    statsComplete: true,
    ...(scope === 'all' || scope === 'branch' ? { baseState: 'ready' as const } : {}),
    ...more,
});

const readyBase: GitBase = {
    state: 'ready',
    name: 'origin/main',
    commit: '2'.repeat(40),
    mergeBase: '3'.repeat(40),
    ahead: 2,
    behind: 1,
    commits: FIXTURE_GIT_COMMITS,
};

const statusOf = (base: GitBase): GitStatus => ({
    isRepository: true,
    head: { kind: 'branch', name: 'feature', commit: '9'.repeat(40) },
    origin: true,
    entries: [],
    base,
});

/** A transport whose lists and files the test decides, which counts what it is asked. */
function transportOf(
    answers: Partial<Record<GitScope, GitChanges | (() => GitChanges | Promise<GitChanges>)>>,
    status: GitStatus = statusOf(readyBase)
) {
    const changes = vi.fn(async (_project: string, _place: unknown, scope: GitScope) => {
        const answer = answers[scope];

        if (answer === undefined) throw new TransportError(`Commit ${scope} does not exist`, 404);

        return typeof answer === 'function' ? answer() : answer;
    });
    const fileRead = vi.fn(
        async (
            _project: string,
            _place: unknown,
            _scope: GitScope,
            _path: string,
            _oldPath?: string,
            _from?: string
        ): Promise<GitFileSides> => ({ state: 'text', original: 'a\n', modified: 'b\n', revision: 'r' })
    );
    const viewedRead = vi.fn(
        async (_project: string, _place: unknown, _scope: GitScope): Promise<GitViewedMark[]> => []
    );
    const viewedSet = vi.fn(
        async (
            _project: string,
            _place: unknown,
            _scope: GitScope,
            path: string,
            revision: string
        ): Promise<GitViewedMark> => ({ path, revision })
    );
    const viewedClear = vi.fn(
        async (_project: string, _place: unknown, _scope: GitScope, _path: string): Promise<void> => undefined
    );

    return {
        getGitStatus: vi.fn(async () => status),
        getGitChanges: changes,
        getGitFile: fileRead,
        getGitViewed: viewedRead,
        setGitViewed: viewedSet,
        clearGitViewed: viewedClear,
        getGitPullRequest: vi.fn(async () => ({ isRepository: true as const, access: 'ready' as const })),
    };
}

/** The changes model of a place, with its status read so that its base is known. */
async function modelOf(transport: ReturnType<typeof transportOf>, collapseDiffs = false) {
    const facts = new PlaceFacts(KEY, transport);

    await facts.status.refresh();

    return { facts, model: new PlaceChanges(facts, transport, { collapseDiffs }) };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('the list of the scope', () => {
    it('is read for the scope that was chosen, with the place the facts are of, and is the last good list of that scope', async () => {
        const transport = transportOf({
            all: list('all', [file('a.ts')]),
            uncommitted: list('uncommitted', [file('b.ts')]),
        });
        const { model } = await modelOf(transport);

        expect(model.changes).toBeUndefined();

        model.sync(1);
        await tick();

        expect(transport.getGitChanges).toHaveBeenCalledWith('p1', { folderId: 'f1', workspaceId: 'w1' }, 'all');
        expect(model.changes?.files.map(entry => entry.path)).toEqual(['a.ts']);

        model.setScope('uncommitted');
        // Never the other scope's list while this one is on its way.
        expect(model.changes).toBeUndefined();

        model.sync(1);
        await tick();

        expect(model.changes?.files.map(entry => entry.path)).toEqual(['b.ts']);

        // Back to the first, which shows its last list while it is read again.
        let release: (answer: GitChanges) => void = () => undefined;

        transport.getGitChanges.mockImplementationOnce(
            () =>
                new Promise<GitChanges>(resolve => {
                    release = resolve;
                })
        );
        model.setScope('all');
        model.sync(1);

        expect(model.changes?.files.map(entry => entry.path)).toEqual(['a.ts']);
        expect(model.list.loading).toBe(true);

        release(list('all', [file('a.ts'), file('c.ts')]));
        await tick();

        expect(model.changes?.files.map(entry => entry.path)).toEqual(['a.ts', 'c.ts']);
    });

    it('is read once for a round of the facts, and again when the facts start another or the scope changes', async () => {
        const transport = transportOf({ all: list('all', [file('a.ts')]), uncommitted: list('uncommitted', []) });
        const { model } = await modelOf(transport);

        model.sync(1);
        model.sync(1);
        model.sync(1);
        expect(transport.getGitChanges).toHaveBeenCalledTimes(1);

        model.sync(2);
        expect(transport.getGitChanges).toHaveBeenCalledTimes(2);

        model.setScope('uncommitted');
        model.sync(2);
        expect(transport.getGitChanges).toHaveBeenCalledTimes(3);
        expect(transport.getGitChanges).toHaveBeenLastCalledWith('p1', expect.anything(), 'uncommitted');

        // A retry reads whatever the round is.
        model.reload();
        expect(transport.getGitChanges).toHaveBeenCalledTimes(4);
    });

    it("follows the facts' rounds: a refresh of the store reaches it through the generation, with no timer of its own", async () => {
        const transport = transportOf({ all: list('all', [file('a.ts')]) });
        const { facts, model } = await modelOf(transport);

        expect(facts.generation).toBe(0);

        model.sync(facts.generation);
        await tick();
        runInAction(() => facts.startRound());
        model.sync(facts.generation);
        await tick();

        expect(facts.generation).toBe(1);
        expect(transport.getGitChanges).toHaveBeenCalledTimes(2);
    });

    it('keeps the last list when a later read fails, and says so', async () => {
        const answers: Array<GitChanges | Error> = [list('all', [file('a.ts')]), new Error('The daemon answered 503')];
        const transport = transportOf({
            all: () => {
                const next = answers.shift()!;

                if (next instanceof Error) throw next;

                return next;
            },
        });
        const { model } = await modelOf(transport);

        model.sync(1);
        await tick();
        model.sync(2);
        await tick();

        expect(model.changes?.files.map(entry => entry.path)).toEqual(['a.ts']);
        expect(model.list.stale).toBe(true);
        expect(model.list.error).toBe('The daemon answered 503');
        expect(listStateOf(model)).toEqual({ kind: 'files' });
    });

    it('drops an answer that comes after a newer read was made', async () => {
        const slow: Array<(answer: GitChanges) => void> = [];
        const transport = transportOf({ all: () => new Promise<GitChanges>(resolve => slow.push(resolve)) });
        const { model } = await modelOf(transport);

        model.sync(1);
        model.sync(2);

        slow[1]!(list('all', [file('new.ts')]));
        await tick();
        slow[0]!(list('all', [file('old.ts')]));
        await tick();

        expect(model.changes?.files.map(entry => entry.path)).toEqual(['new.ts']);
    });
});

describe('the scope', () => {
    it('shows one commit of the branch alone on a press, and all changes again on a second press on it or on a press on all changes', async () => {
        const transport = transportOf({
            all: list('all', [file('a.ts')]),
            [commitScope(NEWEST.sha)]: list(commitScope(NEWEST.sha), [file('b.ts')], { from: OLDEST.sha }),
        });
        const { model } = await modelOf(transport);

        model.pickCommit(NEWEST.sha);
        expect(model.effectiveScope).toBe(commitScope(NEWEST.sha));

        model.sync(1);
        await tick();
        expect(model.changes?.files.map(entry => entry.path)).toEqual(['b.ts']);

        model.pickCommit(NEWEST.sha);
        expect(model.effectiveScope).toBe('all');

        model.pickCommit(OLDEST.sha);
        model.setScope('all');
        expect(model.effectiveScope).toBe('all');
    });

    it('reads all changes where the branch has no base to be counted against, and the branch again once there is one', async () => {
        const noBase = transportOf({ all: list('all', []) }, statusOf({ state: 'no_base' }));
        const { model } = await modelOf(noBase);

        model.setScope('branch');

        expect(model.scope).toBe('branch');
        expect(model.effectiveScope).toBe('all');

        const withBase = await modelOf(transportOf({ branch: list('branch', []) }));

        withBase.model.setScope('branch');
        expect(withBase.model.effectiveScope).toBe('branch');
    });

    it('goes back to all changes when the commit it was on is gone, as after a rewrite of the branch', async () => {
        const transport = transportOf({ all: list('all', [file('a.ts')]) });
        const { model } = await modelOf(transport);

        model.setScope(commitScope('e'.repeat(40)));
        model.sync(1);
        await tick();

        expect(model.scope).toBe('all');

        model.sync(1);
        await tick();

        expect(model.changes?.files.map(entry => entry.path)).toEqual(['a.ts']);
    });

    it('does not leave a scope it cannot read for a failure that is not a missing commit', async () => {
        const transport = transportOf({
            [commitScope(NEWEST.sha)]: () => {
                throw new TransportError('The daemon answered 503', 503);
            },
        });
        const { model } = await modelOf(transport);

        model.pickCommit(NEWEST.sha);
        model.sync(1);
        await tick();

        expect(model.scope).toBe(commitScope(NEWEST.sha));
        expect(listStateOf(model)).toEqual({ kind: 'failed', message: 'The daemon answered 503' });
    });
});

describe('the filter and the cards', () => {
    const files = [file('docs/guide.md'), file('src/a.ts'), file('src/a.test.ts'), file('README.md')];

    async function filled() {
        const { model } = await modelOf(transportOf({ all: list('all', files) }));

        model.sync(1);
        await tick();

        return model;
    }

    it('narrows the files by the filter text, for the cards', async () => {
        const model = await filled();

        expect(model.files).toHaveLength(4);

        model.setFilter('src/**, !*.test.ts');
        expect(model.files.map(entry => entry.path)).toEqual(['src/a.ts']);

        model.setFilter('');
        expect(model.files).toHaveLength(4);
    });

    it('has every card open, shuts them all and opens them all, and reveals one by path', async () => {
        const model = await filled();

        expect(model.allFolded).toBe(false);
        expect(model.files.every(file => !model.isFolded(file.path))).toBe(true);

        model.toggleFolded('src/a.ts');
        expect([model.isFolded('src/a.ts'), model.allFolded]).toEqual([true, false]);

        model.foldAll();
        expect(model.allFolded).toBe(true);

        model.reveal('README.md');
        expect([model.isFolded('README.md'), model.isFolded('docs/guide.md'), model.allFolded]).toEqual([
            false,
            true,
            false,
        ]);

        model.unfoldAll();
        expect(model.files.every(file => !model.isFolded(file.path))).toBe(true);
    });

    it('shuts only the cards the filter shows, and opens every card the filter hides too', async () => {
        const model = await filled();

        model.setFilter('*.md');
        model.foldAll();
        expect(model.files.every(file => model.isFolded(file.path))).toBe(true);
        expect(model.allFolded).toBe(true);

        model.setFilter('');
        expect(model.allFolded).toBe(false);

        model.unfoldAll();
        expect(model.files.every(file => !model.isFolded(file.path))).toBe(true);
    });

    it('folds new files after a refresh while preserving cards opened by hand', async () => {
        let current = list('all', files.slice(0, 1));
        const { model } = await modelOf(transportOf({ all: () => current }), true);

        model.sync(1);
        await tick();
        expect(model.allFolded).toBe(true);
        model.reveal(files[0]!.path);

        current = list('all', files);
        model.sync(2);
        await tick();

        expect(model.files).toHaveLength(files.length);
        expect(model.files.filter(file => !model.isFolded(file.path))).toEqual([files[0]]);
    });

    it("asks the cache for a file with the list's own start and the file's revision, and a refresh reads only the files whose revision changed", async () => {
        let current = list('all', files);
        const transport = transportOf({ all: () => current });
        const { model } = await modelOf(transport);

        model.sync(1);
        await tick();

        for (const entry of model.files) model.sides.want(model.requestOf(entry));

        await tick();

        expect(transport.getGitFile).toHaveBeenCalledTimes(4);
        expect(transport.getGitFile).toHaveBeenCalledWith(
            'p1',
            { folderId: 'f1', workspaceId: 'w1' },
            'all',
            'docs/guide.md',
            undefined,
            'f'.repeat(40)
        );

        // The list is read again: one file was edited.
        current = list(
            'all',
            files.map(entry => (entry.path === 'src/a.ts' ? { ...entry, revision: 'r2' } : entry))
        );
        model.sync(2);
        await tick();

        for (const entry of model.files) model.sides.want(model.requestOf(entry));

        await tick();

        expect(transport.getGitFile).toHaveBeenCalledTimes(5);
        expect(transport.getGitFile).toHaveBeenLastCalledWith(
            'p1',
            expect.anything(),
            'all',
            'src/a.ts',
            undefined,
            'f'.repeat(40)
        );
        expect(model.files.map(entry => model.sides.entryOf(model.requestOf(entry))?.status)).toEqual([
            'ready',
            'ready',
            'ready',
            'ready',
        ]);
    });

    it('sends the old path of a renamed file along', async () => {
        const { model } = await modelOf(
            transportOf({ all: list('all', [file('b.ts', 'r1', { kind: 'renamed', oldPath: 'a.ts' })]) })
        );

        model.sync(1);
        await tick();

        expect(model.requestOf(model.files[0]!)).toMatchObject({ path: 'b.ts', oldPath: 'a.ts' });

        model.sides.want(model.requestOf(model.files[0]!));
        await tick();
        expect(model.sides.entryOf(model.requestOf(model.files[0]!))?.status).toBe('ready');
    });
});

describe('the model of a place', () => {
    it('is the same one for the same facts, and another for facts that were made again; the latest places are kept', () => {
        const transport = transportOf({});
        const facts = new PlaceFacts(KEY, transport);
        const model = placeChangesOf(transport, facts);

        expect(placeChangesOf(transport, facts)).toBe(model);
        expect(placeChangesOf(transport, new PlaceFacts(KEY, transport))).not.toBe(model);

        const other = transportOf({});
        const first = new PlaceFacts(KEY, other);
        const kept = placeChangesOf(other, first);

        for (const name of ['a', 'b', 'c', 'd'])
            placeChangesOf(other, new PlaceFacts({ ...KEY, folderId: name }, other));

        expect(placeChangesOf(other, first)).not.toBe(kept);
    });

    it('keeps its scope and its filter for the next time the tab is on show', () => {
        const transport = transportOf({});
        const facts = new PlaceFacts(KEY, transport);

        placeChangesOf(transport, facts).setScope('uncommitted');
        placeChangesOf(transport, facts).setFilter('*.md');

        expect(placeChangesOf(transport, facts)).toMatchObject({ scope: 'uncommitted', filter: '*.md' });
    });
});

describe('the viewed files', () => {
    const files = [file('docs/guide.md'), file('src/a.ts'), file('src/b.ts'), file('README.md')];
    const PLACE = { folderId: 'f1', workspaceId: 'w1' };

    /** A model whose list is `files` and whose daemon already holds `marks` for the scope `all`, read once. */
    async function viewedModel(marks: GitViewedMark[] = [], answers: Partial<Record<GitScope, GitViewedMark[]>> = {}) {
        const transport = transportOf({ all: list('all', files), uncommitted: list('uncommitted', files.slice(0, 2)) });

        transport.getGitViewed.mockImplementation(async (_project, _place, scope) =>
            scope === 'all' ? marks : (answers[scope] ?? [])
        );

        const { model } = await modelOf(transport);

        model.sync(1);
        await tick();

        return { model, transport };
    }

    it('are read with the list of the scope that is read, again with each round of the facts and with a retry, and not for a folder that is no repository', async () => {
        const { model, transport } = await viewedModel([{ path: 'src/a.ts', revision: 'r1' }]);

        expect(transport.getGitViewed).toHaveBeenCalledTimes(1);
        expect(transport.getGitViewed).toHaveBeenCalledWith('p1', PLACE, 'all');
        expect(model.isViewed('src/a.ts')).toBe(true);

        // The same round again reads nothing; a new round reads the marks with the list.
        model.sync(1);
        await tick();
        expect(transport.getGitViewed).toHaveBeenCalledTimes(1);
        model.sync(2);
        await tick();
        expect(transport.getGitViewed).toHaveBeenCalledTimes(2);
        model.reload();
        await tick();
        expect(transport.getGitViewed).toHaveBeenCalledTimes(3);

        model.setScope('uncommitted');
        model.sync(2);
        await tick();
        expect(transport.getGitViewed).toHaveBeenLastCalledWith('p1', PLACE, 'uncommitted');
        // Another scope has its own marks, and none here.
        expect(model.viewedCount).toBe(0);

        const none = transportOf({ all: list('all', []) }, { isRepository: false });
        const { model: plain } = await modelOf(none);

        plain.sync(1);
        await tick();
        expect(none.getGitViewed).not.toHaveBeenCalled();
    });

    it('count a file as viewed only while its revision is the one it was marked at', async () => {
        const { model } = await viewedModel([
            { path: 'src/a.ts', revision: 'r1' },
            { path: 'src/b.ts', revision: 'old' },
        ]);

        expect([...model.viewedPaths]).toEqual(['src/a.ts']);
        expect(model.viewedCount).toBe(1);
        expect(model.isViewed('src/b.ts')).toBe(false);
        expect(model.isViewed('nothing.ts')).toBe(false);
    });

    it('make the card of a viewed file shut until the person opens it, and open again once the list says the file was edited', async () => {
        let current = list('all', files);
        const transport = transportOf({ all: () => current });

        transport.getGitViewed.mockImplementation(async () => [{ path: 'src/a.ts', revision: 'r1' }]);

        const { model } = await modelOf(transport);

        model.sync(1);
        await tick();

        expect(model.isFolded('src/a.ts')).toBe(true);
        expect(model.isFolded('src/b.ts')).toBe(false);

        model.toggleFolded('src/a.ts');
        expect(model.isFolded('src/a.ts')).toBe(false);
        model.toggleFolded('src/a.ts');
        expect(model.isFolded('src/a.ts')).toBe(true);

        // The file is edited, and its list is read again: the mark is stale, so the card is as any card is: open.
        current = list(
            'all',
            files.map(entry => (entry.path === 'src/a.ts' ? { ...entry, revision: 'r2' } : entry))
        );
        model.sync(2);
        await tick();
        expect(model.isViewed('src/a.ts')).toBe(false);
        expect(model.isFolded('src/a.ts')).toBe(false);
    });

    it('shut a card when its file is ticked and open it when it is unticked, before the daemon has answered, and a card the person shut stays shut on a tick', async () => {
        const { model, transport } = await viewedModel([]);
        const answer: Array<() => void> = [];

        transport.setGitViewed.mockImplementationOnce(
            () =>
                new Promise<GitViewedMark>(resolve => {
                    answer.push(() => resolve({ path: 'src/a.ts', revision: 'r1' }));
                })
        );

        const ticking = model.setViewed(files[1]!, true);

        expect(model.isViewed('src/a.ts')).toBe(true);
        expect(model.isFolded('src/a.ts')).toBe(true);
        expect(transport.getGitViewed).toHaveBeenCalledTimes(1);

        answer[0]!();
        await ticking;
        expect(model.isViewed('src/a.ts')).toBe(true);
        expect(model.isFolded('src/a.ts')).toBe(true);

        await model.setViewed(files[1]!, false);
        expect(model.isViewed('src/a.ts')).toBe(false);
        expect(model.isFolded('src/a.ts')).toBe(false);
        expect(transport.clearGitViewed).toHaveBeenCalledWith('p1', PLACE, 'all', 'src/a.ts');

        // A card the person had shut is still shut when its file is ticked, and open when it is unticked.
        model.toggleFolded('src/b.ts');
        await model.setViewed(files[2]!, true);
        expect(model.isFolded('src/b.ts')).toBe(true);
        await model.setViewed(files[2]!, false);
        expect(model.isFolded('src/b.ts')).toBe(false);
    });

    it('put the tick and the card back as they were when the daemon refuses, and say so', async () => {
        const { model, transport } = await viewedModel([{ path: 'src/b.ts', revision: 'r1' }]);

        transport.setGitViewed.mockRejectedValueOnce(new TransportError('The worktree is missing', 503));
        await model.setViewed(files[1]!, true);

        expect(model.isViewed('src/a.ts')).toBe(false);
        expect(model.isFolded('src/a.ts')).toBe(false);
        expect(model.viewed.error).toBe('The worktree is missing');

        // The same for a mark that is cleared: it stays, and its card is as the person had left it (opened).
        model.reveal('src/b.ts');
        expect(model.isFolded('src/b.ts')).toBe(false);
        transport.clearGitViewed.mockRejectedValueOnce(new TransportError('no', 503));
        await model.setViewed(files[2]!, false);
        expect(model.isViewed('src/b.ts')).toBe(true);
        expect(model.isFolded('src/b.ts')).toBe(false);
    });

    it("send the mark of the scope that is read, with the revision of the file in that scope's list", async () => {
        const { model, transport } = await viewedModel();

        model.setScope('uncommitted');
        model.sync(1);
        await tick();
        await model.setViewed(file('src/a.ts', 'rev-u'), true);

        expect(transport.setGitViewed).toHaveBeenCalledWith('p1', PLACE, 'uncommitted', 'src/a.ts', 'rev-u');
    });

    it('leave the files out of the list while they are hidden, and bring them back, the filter counting as before', async () => {
        const { model } = await viewedModel([
            { path: 'src/a.ts', revision: 'r1' },
            { path: 'README.md', revision: 'r1' },
        ]);

        expect(model.files.map(entry => entry.path)).toEqual(['docs/guide.md', 'src/a.ts', 'src/b.ts', 'README.md']);

        model.setHideViewed(true);
        expect(model.files.map(entry => entry.path)).toEqual(['docs/guide.md', 'src/b.ts']);
        expect(model.matchingFiles).toHaveLength(4);
        // The count is of the list, hidden or not.
        expect(model.viewedCount).toBe(2);

        model.setFilter('src/**');
        expect(model.files.map(entry => entry.path)).toEqual(['src/b.ts']);

        model.setHideViewed(false);
        expect(model.files.map(entry => entry.path)).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('drop a card from the list as soon as its file is ticked while they are hidden, and show it again when the tick is taken back', async () => {
        const { model } = await viewedModel();

        model.setHideViewed(true);
        expect(model.files).toHaveLength(4);

        const ticking = model.setViewed(files[3]!, true);

        expect(model.files.map(entry => entry.path)).toEqual(['docs/guide.md', 'src/a.ts', 'src/b.ts']);
        await ticking;
        await model.setViewed(files[3]!, false);
        expect(model.files).toHaveLength(4);
    });

    it('say every file is viewed, and not that the filter lets nothing through, when the hidden files are all there is', async () => {
        const { model } = await viewedModel(files.map(entry => ({ path: entry.path, revision: entry.revision })));

        expect(listStateOf(model)).toEqual({ kind: 'files' });

        model.setHideViewed(true);
        expect(model.files).toEqual([]);
        expect(listStateOf(model)).toEqual({ kind: 'allViewed' });

        // A filter that matches nothing is that, whatever is hidden.
        model.setFilter('*.rs');
        expect(listStateOf(model)).toEqual({ kind: 'filtered' });

        model.setFilter('');
        model.setHideViewed(false);
        expect(listStateOf(model)).toEqual({ kind: 'files' });
    });

    it('shut and open the viewed cards with the others when asked to, and start a tab with the viewed ones shut and the rest open', async () => {
        const { model } = await viewedModel([{ path: 'src/a.ts', revision: 'r1' }]);

        expect([model.isFolded('src/a.ts'), model.allFolded]).toEqual([true, false]);

        model.unfoldAll();
        expect(model.files.every(file => !model.isFolded(file.path))).toBe(true);

        model.foldAll();
        expect([model.isFolded('src/b.ts'), model.allFolded]).toEqual([true, true]);

        model.toggleFolded('docs/guide.md');
        model.resetFolds();
        expect([model.isFolded('docs/guide.md'), model.isFolded('src/a.ts'), model.isFolded('src/b.ts')]).toEqual([
            false,
            true,
            false,
        ]);
    });

    it("stay out of the files' texts: ticking a file reads no file and changes no request of the cache", async () => {
        const { model, transport } = await viewedModel();
        const before = model.requestOf(files[1]!);

        await model.setViewed(files[1]!, true);

        expect(transport.getGitFile).not.toHaveBeenCalled();
        expect(model.requestOf(files[1]!)).toEqual(before);
        expect(model.sides.entryOf(before)).toBeUndefined();
    });
});

describe('the uncommitted files for the commit box', () => {
    it('are read for the box whatever scope is shown, once for each round of reads, and are the shown list itself when the scope is uncommitted', async () => {
        const transport = transportOf({
            all: list('all', [file('a.ts'), file('b.ts')]),
            uncommitted: list('uncommitted', [file('b.ts')]),
            branch: list('branch', [file('a.ts')]),
        });
        const { model } = await modelOf(transport);
        const reads = (scope: GitScope) => transport.getGitChanges.mock.calls.filter(call => call[2] === scope).length;

        expect(model.uncommitted).toBeUndefined();

        model.sync(1);
        model.syncUncommitted(1);
        await tick();

        expect(model.changes?.files.map(entry => entry.path)).toEqual(['a.ts', 'b.ts']);
        expect(model.uncommitted?.files.map(entry => entry.path)).toEqual(['b.ts']);

        // The same round is read once; a new round reads again.
        model.syncUncommitted(1);
        expect(reads('uncommitted')).toBe(1);
        model.syncUncommitted(2);
        await tick();
        expect(reads('uncommitted')).toBe(2);

        // The shown scope is the uncommitted one: the tab's own read is the only read, and the box sees its list.
        model.setScope('uncommitted');
        model.sync(3);
        model.syncUncommitted(3);
        await tick();
        expect(reads('uncommitted')).toBe(3);
        expect(model.changes).toBe(model.uncommitted);

        // Visiting many other scopes does not let the box's list go.
        for (const scope of FIXTURE_GIT_COMMITS.map(commit => commitScope(commit.sha))) {
            model.setScope(scope);
            model.sync(4);
        }

        model.setScope('branch');
        model.sync(4);
        await tick();
        expect(model.uncommitted?.files.map(entry => entry.path)).toEqual(['b.ts']);
    });
});

describe('the last run of the open chat', () => {
    const RUN = turnScope('a'.repeat(40), 'b'.repeat(40));
    const NEXT_RUN = turnScope('b'.repeat(40), 'c'.repeat(40));
    const OTHER_RUN = turnScope('d'.repeat(40), 'e'.repeat(40));

    const runs = () =>
        transportOf({
            all: list('all', [file('a.ts')]),
            [RUN]: list(RUN, [file('run.ts', 'rr'), file('also.ts', 'ra')], { from: undefined }),
            [NEXT_RUN]: list(NEXT_RUN, [file('next.ts')]),
        });

    it("is a scope of its own only while the tab is told the chat has one: the choice follows the chat's run, and a newer run replaces it", async () => {
        const transport = runs();
        const { model } = await modelOf(transport);

        model.setRun('chat-1', RUN);
        expect(model.effectiveScope).toBe('all');

        model.setScope(RUN);
        expect(model.effectiveScope).toBe(RUN);
        // What the person chose among the other scopes is left as it was.
        expect(model.scope).toBe('all');

        model.sync(1);
        await tick();
        expect(transport.getGitChanges).toHaveBeenCalledWith('p1', { folderId: 'f1', workspaceId: 'w1' }, RUN);
        expect(model.changes?.files.map(entry => entry.path)).toEqual(['run.ts', 'also.ts']);

        // The chat's next run ends: the tab follows it, as the person was looking at the last one.
        model.setRun('chat-1', NEXT_RUN);
        expect(model.effectiveScope).toBe(NEXT_RUN);
        model.sync(1);
        await tick();
        expect(model.changes?.files.map(entry => entry.path)).toEqual(['next.ts']);

        // A chat with no run that changed files has none to follow.
        model.setRun('chat-1', undefined);
        expect(model.effectiveScope).toBe('all');
    });

    it('stops following the run on a pick of another scope or commit, and is not followed to another chat', async () => {
        const { model } = await modelOf(runs());

        model.setRun('chat-1', RUN);
        model.setScope(RUN);
        model.setScope('uncommitted');
        expect(model.effectiveScope).toBe('uncommitted');

        model.setScope(RUN);
        model.pickCommit(NEWEST.sha);
        expect(model.effectiveScope).toBe(commitScope(NEWEST.sha));
        model.setScope('all');
        expect(model.effectiveScope).toBe('all');

        // Following one chat's run is not following the next chat's: the place is shared, the run is the open chat's.
        model.setScope(RUN);
        expect(model.effectiveScope).toBe(RUN);
        model.setRun('chat-2', OTHER_RUN);
        expect(model.effectiveScope).toBe('all');
        // The same chat with a newer run keeps following.
        model.setScope(OTHER_RUN);
        model.setRun('chat-2', NEXT_RUN);
        expect(model.effectiveScope).toBe(NEXT_RUN);
    });

    it("takes no scope for the run that is not the chat's own", async () => {
        const { model } = await modelOf(runs());

        model.setRun('chat-1', RUN);
        model.setScope(OTHER_RUN);
        expect(model.effectiveScope).toBe('all');
        model.setScope(NEXT_RUN);
        expect(model.effectiveScope).toBe('all');
    });

    it("is shown by a press on the plate: the chat's run is followed from the start, and the file to bring up waits for the list that has it", async () => {
        const { model } = await modelOf(runs());

        model.showRun('chat-1', RUN, 'also.ts');
        expect(model.effectiveScope).toBe(RUN);
        expect(model.revealRequest).toBe('also.ts');
        // The tab is drawn after, and tells the model the same chat and run: nothing is undone.
        model.setRun('chat-1', RUN);
        expect(model.effectiveScope).toBe(RUN);
        expect(model.revealRequest).toBe('also.ts');

        model.clearRevealRequest();
        expect(model.revealRequest).toBeUndefined();

        model.showRun('chat-1', RUN);
        expect(model.revealRequest).toBeUndefined();
    });

    it('drops the file to bring up when the person picks another scope before the list of the run has it', async () => {
        const { model } = await modelOf(runs());

        model.showRun('chat-1', RUN, 'also.ts');
        model.setScope('uncommitted');
        expect(model.revealRequest).toBeUndefined();

        model.showRun('chat-1', RUN, 'also.ts');
        model.pickCommit('c1');
        expect(model.revealRequest).toBeUndefined();
    });

    it('keeps its viewed marks under its own scope, which an edit of the files afterwards does not change', async () => {
        const transport = runs();
        const { model } = await modelOf(transport);

        model.showRun('chat-1', RUN);
        model.sync(1);
        await tick();
        expect(transport.getGitViewed).toHaveBeenCalledWith('p1', { folderId: 'f1', workspaceId: 'w1' }, RUN);

        await model.setViewed(model.changes!.files[0]!, true);
        expect(transport.setGitViewed).toHaveBeenCalledWith(
            'p1',
            { folderId: 'f1', workspaceId: 'w1' },
            RUN,
            'run.ts',
            'rr'
        );
        expect(model.isViewed('run.ts')).toBe(true);
        expect(model.isViewed('also.ts')).toBe(false);
    });

    it('says the run is gone when its trees were pruned, and keeps the choice of the run', async () => {
        const transport = runs();

        transport.getGitChanges.mockImplementation(async (_project, _place, scope) => {
            if (scope === RUN) throw new TransportError('The changes of that run are no longer in the repository', 503);

            return list(scope, []);
        });

        const { model } = await modelOf(transport);

        model.showRun('chat-1', RUN);
        model.sync(1);
        await tick();

        expect(model.changes).toBeUndefined();
        expect(model.list.error).toBe('The changes of that run are no longer in the repository');
        expect(listStateOf(model)).toEqual({
            kind: 'failed',
            message: 'The changes of that run are no longer in the repository',
        });
        expect(model.effectiveScope).toBe(RUN);
    });
});
