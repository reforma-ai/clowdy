import { observable, runInAction } from 'mobx';
import { describe, expect, it, vi } from 'vitest';

import { TransportError } from '../../daemon/transport';
import { ProjectUi } from '../../stores';
import { DocsStore } from './DocsStore';

import type { CommandResult, DocNode } from '@clowdy/protocol';
import type { CommandInput } from '../../daemon/transport';
import type { ProjectState } from '../../stores';

const hashOf = (content: string) => `h(${ content })`;

/** The docs folder as a daemon would hold it: files in memory, the same answers, and the event feed's `docs.changed`. */
function setup(initial: Record<string, string>, docPath: string | null = null) {
    const files = new Map(Object.entries(initial));
    const commands: CommandInput[] = [];
    const project = observable<Pick<ProjectState, 'id' | 'lastDocsChange'>>({ id: 'p1', lastDocsChange: null });
    const ui = new ProjectUi('p1');
    let cursor = 0;
    let gate: Promise<void> | undefined;
    let readGate: Promise<void> | undefined;
    let answerNext: CommandResult | undefined;
    let readsFail = false;

    runInAction(() => {
        ui.docPath = docPath;
    });

    const emit = (path: string, change: 'created' | 'modified' | 'removed') => runInAction(() => {
        project.lastDocsChange = { path, change, cursor: ++cursor };
    });

    const transport = {
        getDocsTree: async () => treeOf([...files.keys()]),
        getDocFile: async (_projectId: string, path: string) => {
            // The file is read when asked, and the answer may be late.
            const content = files.get(path);
            const held = readGate;

            readGate = undefined;
            await held;

            if (readsFail) throw new TransportError('The daemon answered 500', 500);

            if (content === undefined) throw new TransportError(`No such file: ${ path }`, 404);

            return { path, content, hash: hashOf(content) };
        },
    };

    const command = async (input: CommandInput): Promise<CommandResult> => {
        commands.push(input);

        if (answerNext) {
            const answer = answerNext;

            answerNext = undefined;

            return answer;
        }

        if (input.type !== 'docs.write') throw new Error(`Unexpected command ${ input.type }`);

        const existing = files.get(input.path);
        const found = existing === undefined ? undefined : { path: input.path, content: existing, hash: hashOf(existing) };
        let result: CommandResult;

        if (input.baseHash === null && found) result = refusal('conflict', found);
        else if (input.baseHash !== null && !found) result = refusal('not_found');
        else if (found && found.hash !== input.baseHash) result = refusal('conflict', found);
        else {
            files.set(input.path, input.content);
            emit(input.path, found ? 'modified' : 'created');
            result = { ok: true, requestId: 'r', data: { path: input.path, hash: hashOf(input.content) } };
        }

        await gate;

        return result;
    };

    const store = new DocsStore({ project, ui, transport, command });

    return {
        store,
        ui,
        files,
        commands,
        /** Someone else writes the file: an agent, or another editor. */
        external: (path: string, content: string) => {
            const existed = files.has(path);

            files.set(path, content);
            emit(path, existed ? 'modified' : 'created');
        },
        /** The feed says a file changed, whether it did or not. */
        announce: (path: string) => emit(path, 'modified'),
        externalRemove: (path: string) => {
            for (const key of [...files.keys()]) if (key === path || key.startsWith(`${ path }/`)) files.delete(key);

            emit(path, 'removed');
        },
        /** Holds the answers of saves until the returned function is called. */
        holdAnswers: () => {
            let release!: () => void;

            gate = new Promise<void>((resolve) => {
                release = resolve;
            });

            return () => {
                gate = undefined;
                release();
            };
        },
        /** Holds the next read of a file until the returned function is called. */
        holdReads: () => {
            let release!: () => void;

            readGate = new Promise<void>((resolve) => {
                release = resolve;
            });

            return release;
        },
        /** The next command gets this answer and does nothing on disk. */
        answerNextWith: (result: CommandResult) => {
            answerNext = result;
        },
        failReads: (fail: boolean) => {
            readsFail = fail;
        },
    };
}

function refusal(code: 'conflict' | 'not_found' | 'unavailable' | 'invalid', details?: unknown, message: string = code): CommandResult {
    return { ok: false, requestId: 'r', error: { code, message, details } };
}

function treeOf(paths: string[]): DocNode[] {
    const root: DocNode[] = [];

    for (const path of paths) {
        const parts = path.split('/');
        let level = root;

        parts.forEach((name, index) => {
            const nodePath = parts.slice(0, index + 1).join('/');
            const isFile = index === parts.length - 1;
            let node = level.find(candidate => candidate.path === nodePath);

            if (!node) {
                node = isFile ? { path: nodePath, name, kind: 'file' } : { path: nodePath, name, kind: 'dir', children: [] };
                level.push(node);
            }

            level = node.children ?? [];
        });
    }

    const sort = (nodes: DocNode[]) => {
        nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
        nodes.forEach(node => node.children && sort(node.children));
    };

    sort(root);

    return root;
}

/** A store showing `docPath` (or the first document), loaded. */
async function opened(initial: Record<string, string>, docPath: string | null = null) {
    const world = setup(initial, docPath);

    world.store.activate();
    await vi.waitFor(() => expect(world.store.current?.status).toBe('ready'));

    return world;
}

const FILES = { 'a.md': 'alpha\n', 'notes/b.md': 'bravo\n', 'notes/c.md': 'charlie\n' };

describe('DocsStore selection', () => {
    it('opens the stored selection', async () => {
        const { store } = await opened(FILES, 'notes/b.md');

        expect(store.currentPath).toBe('notes/b.md');
        expect(store.current?.text).toBe('bravo\n');
    });

    it('falls back to the first document when the stored one is gone, or nothing was stored', async () => {
        expect((await opened(FILES, 'removed.md')).store.currentPath).toBe('notes/b.md');
        expect((await opened(FILES)).store.currentPath).toBe('notes/b.md');
    });

    it('opens the folders above the selection and the top-level ones', async () => {
        const { store } = await opened({ 'a.md': 'a', 'deep/er/x.md': 'x', 'other/y.md': 'y' }, 'deep/er/x.md');

        expect([...store.expanded].sort()).toEqual(['deep', 'deep/er', 'other']);
    });

    it('shows nothing selected, and no error, when there are no documents', async () => {
        const { store } = setup({});

        store.activate();
        await vi.waitFor(() => expect(store.treeStatus).toBe('ready'));
        expect(store.currentPath).toBeNull();
        expect(store.current).toBeUndefined();
    });

    it('reports a document that cannot be read, and opens it on retry', async () => {
        const world = setup(FILES, 'a.md');

        world.failReads(true);
        world.store.activate();
        await vi.waitFor(() => expect(world.store.current?.status).toBe('failed'));
        expect(world.store.current?.error).toContain('500');

        world.failReads(false);
        world.store.retry('a.md');
        await vi.waitFor(() => expect(world.store.current?.status).toBe('ready'));
        expect(world.store.current?.text).toBe('alpha\n');
    });

    it('filters the tree by name while keeping the folders above a match', async () => {
        const { store } = await opened(FILES);

        store.setQuery('c.');
        expect(store.visibleTree.map(node => node.path)).toEqual(['notes']);
        expect(store.visibleTree[0]?.children?.map(node => node.path)).toEqual(['notes/c.md']);
        expect(store.isOpen('notes')).toBe(true);
    });
});

describe('DocsStore saving', () => {
    it('saves over the hash it loaded and is clean after', async () => {
        const { store, files, commands } = await opened(FILES, 'a.md');

        store.current!.edit('alpha\nedited\n');
        expect(store.current?.dirty).toBe(true);
        await store.save();
        expect(commands).toEqual([expect.objectContaining({ type: 'docs.write', path: 'a.md', content: 'alpha\nedited\n', baseHash: hashOf('alpha\n') })]);
        expect(files.get('a.md')).toBe('alpha\nedited\n');
        expect(store.current).toMatchObject({ dirty: false, saving: false, baseHash: hashOf('alpha\nedited\n') });
    });

    it('does not send a save for a clean document', async () => {
        const { store, commands } = await opened(FILES, 'a.md');

        await store.save();
        expect(commands).toEqual([]);
    });

    it('saves again from the new hash, so the second save is no conflict', async () => {
        const { store, files } = await opened(FILES, 'a.md');

        store.current!.edit('one');
        await store.save();
        store.current!.edit('two');
        await store.save();
        expect(files.get('a.md')).toBe('two');
        expect(store.current?.conflict).toBeNull();
    });

    it('keeps the text and reports it when the daemon refuses', async () => {
        const { store, answerNextWith } = await opened(FILES, 'a.md');

        store.current!.edit('mine');
        answerNextWith(refusal('unavailable', undefined, 'The daemon cannot be reached'));
        await store.save();
        expect(store.current).toMatchObject({ text: 'mine', dirty: true, saving: false, saveError: 'The daemon cannot be reached' });

        await store.save();
        expect(store.current).toMatchObject({ dirty: false, saveError: '' });
    });

    it('waits out a change that is announced while a save is under way, so typing meanwhile is no conflict', async () => {
        const { store, holdAnswers, holdReads } = await opened(FILES, 'a.md');
        const buffer = store.current!;
        const releaseReads = holdReads();
        const releaseAnswers = holdAnswers();

        buffer.edit('first');

        // The daemon writes the file and announces it before it answers; the person types meanwhile.
        const saving = store.save();

        buffer.edit('first, and more');
        releaseReads();
        // Whatever the store would do with that read has happened by now; the daemon has not answered yet.
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(buffer.conflict).toBeNull();
        releaseAnswers();
        await saving;
        await vi.waitFor(() => expect(buffer.baseHash).toBe(hashOf('first')));
        expect(buffer).toMatchObject({ conflict: null, text: 'first, and more', savedText: 'first', edited: true, saving: false });
    });
});

describe('DocsStore external changes', () => {
    it('drops a look at the disk that a save overtook, so the saved text is not replaced by the older file', async () => {
        const { store, announce, holdReads } = await opened(FILES, 'a.md');
        const buffer = store.current!;

        buffer.edit('new text');

        const releaseReads = holdReads();

        // A look begins, and reads the file as it is now: the version before the save.
        announce('a.md');
        await store.save();
        releaseReads();
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(buffer).toMatchObject({ text: 'new text', conflict: null, edited: false, baseHash: hashOf('new text') });
    });

    it('reloads a clean open document silently', async () => {
        const { store, external } = await opened(FILES, 'a.md');

        external('a.md', 'alpha, rewritten by an agent\n');
        await vi.waitFor(() => expect(store.current?.text).toBe('alpha, rewritten by an agent\n'));
        expect(store.current).toMatchObject({ conflict: null, dirty: false });
    });

    it('refreshes the tree when a document appears', async () => {
        const { store, external } = await opened(FILES, 'a.md');

        external('new.md', '# New\n');
        await vi.waitFor(() => expect(store.paths.has('new.md')).toBe(true));
    });

    it('holds a conflict, with the text untouched, when the open document has unsaved edits', async () => {
        const { store, external } = await opened(FILES, 'a.md');

        store.current!.edit('alpha\nmine\n');
        external('a.md', 'alpha\ntheirs\n');
        await vi.waitFor(() => expect(store.current?.conflict).not.toBeNull());
        expect(store.current).toMatchObject({ text: 'alpha\nmine\n', conflict: { content: 'alpha\ntheirs\n' } });

        // A save is not offered while the choice is open.
        await store.save();
        expect(store.current?.saving).toBe(false);
    });

    it('shows the conflict of a save that met another version, the same way', async () => {
        const { store, files } = await opened(FILES, 'a.md');

        store.current!.edit('mine');
        // Written behind the store's back: no event reaches it before the save.
        files.set('a.md', 'theirs');
        await store.save();
        expect(store.current).toMatchObject({ text: 'mine', saving: false, conflict: { content: 'theirs', hash: hashOf('theirs') } });
    });

    it('asks the daemon for the other version when a conflict answer does not carry it', async () => {
        const { store, files, answerNextWith } = await opened(FILES, 'a.md');

        store.current!.edit('mine');
        files.set('a.md', 'theirs');
        answerNextWith(refusal('conflict'));
        await store.save();
        expect(store.current).toMatchObject({ saving: false, conflict: { content: 'theirs', hash: hashOf('theirs') } });
    });

    it('reports the failure, with no conflict, when the other version cannot be fetched either', async () => {
        const { store, answerNextWith, failReads } = await opened(FILES, 'a.md');

        store.current!.edit('mine');
        answerNextWith(refusal('conflict', undefined, 'a.md changed on disk'));
        failReads(true);
        await store.save();
        expect(store.current).toMatchObject({ saving: false, conflict: null, saveError: 'a.md changed on disk', text: 'mine' });
    });

    it('keep mine: overwrites the disk version using its hash', async () => {
        const { store, external, files, commands } = await opened(FILES, 'a.md');
        const buffer = store.current!;

        buffer.edit('mine');
        external('a.md', 'theirs');
        await vi.waitFor(() => expect(buffer.conflict).not.toBeNull());
        await store.keepMine(buffer);
        expect(commands.at(-1)).toMatchObject({ path: 'a.md', content: 'mine', baseHash: hashOf('theirs') });
        expect(files.get('a.md')).toBe('mine');
        expect(buffer).toMatchObject({ conflict: null, dirty: false, text: 'mine' });
    });

    it('keep mine: shows the conflict again if the disk changed once more', async () => {
        const { store, external, files } = await opened(FILES, 'a.md');
        const buffer = store.current!;

        buffer.edit('mine');
        external('a.md', 'theirs');
        await vi.waitFor(() => expect(buffer.conflict).not.toBeNull());
        // The event for the second change has not arrived yet when the person chooses.
        files.set('a.md', 'theirs, again');
        await store.keepMine(buffer);
        expect(files.get('a.md')).toBe('theirs, again');
        expect(buffer).toMatchObject({ text: 'mine', conflict: { content: 'theirs, again' } });
    });

    it('take theirs: drops the edits and shows the disk version', async () => {
        const { store, external, files } = await opened(FILES, 'a.md');
        const buffer = store.current!;

        buffer.edit('mine');
        external('a.md', 'theirs');
        await vi.waitFor(() => expect(buffer.conflict).not.toBeNull());
        store.takeTheirs(buffer);
        expect(buffer).toMatchObject({ text: 'theirs', conflict: null, dirty: false });
        expect(files.get('a.md')).toBe('theirs');
    });

    it('copy mine and take theirs: the edited text goes to a new document first, then the disk version shows', async () => {
        const { store, external, files } = await opened(FILES, 'a.md');
        const buffer = store.current!;

        buffer.edit('mine');
        external('a.md', 'theirs');
        await vi.waitFor(() => expect(buffer.conflict).not.toBeNull());

        const copy = await store.copyMineAndTakeTheirs(buffer);

        expect(copy).toBe('a (my copy).md');
        expect(files.get('a (my copy).md')).toBe('mine');
        expect(buffer).toMatchObject({ text: 'theirs', conflict: null, dirty: false });
        await vi.waitFor(() => expect(store.paths.has('a (my copy).md')).toBe(true));
    });

    it('copy mine and take theirs: changes nothing when the copy cannot be written', async () => {
        const { store, external, answerNextWith } = await opened(FILES, 'a.md');
        const buffer = store.current!;

        buffer.edit('mine');
        external('a.md', 'theirs');
        await vi.waitFor(() => expect(buffer.conflict).not.toBeNull());
        answerNextWith(refusal('unavailable', undefined, 'disk full'));
        expect(await store.copyMineAndTakeTheirs(buffer)).toBeUndefined();
        expect(buffer).toMatchObject({ text: 'mine', conflict: { content: 'theirs' } });
        expect(buffer.saveError).toContain('disk full');
    });
});

describe('DocsStore removed documents', () => {
    it('keeps the text of an open document that was removed, as an unsaved document', async () => {
        const { store, externalRemove } = await opened(FILES, 'a.md');

        store.current!.edit('alpha\nmine\n');
        externalRemove('a.md');
        await vi.waitFor(() => expect(store.current?.removed).toBe(true));
        expect(store.currentPath).toBe('a.md');
        expect(store.current).toMatchObject({ text: 'alpha\nmine\n', dirty: true, baseHash: null });
        // The tree stops listing it, and it is shown on its own, as removed.
        await vi.waitFor(() => expect(store.paths.has('a.md')).toBe(false));
        expect(store.removedBuffers.map(buffer => buffer.path)).toEqual(['a.md']);
    });

    it('creates the file again on save, from no base hash', async () => {
        const { store, externalRemove, files, commands } = await opened(FILES, 'a.md');

        store.current!.edit('alpha\nmine\n');
        externalRemove('a.md');
        await vi.waitFor(() => expect(store.current?.removed).toBe(true));
        await store.save();
        expect(commands.at(-1)).toMatchObject({ path: 'a.md', baseHash: null, content: 'alpha\nmine\n' });
        expect(files.get('a.md')).toBe('alpha\nmine\n');
        expect(store.current).toMatchObject({ removed: false, dirty: false });
        expect(store.removedBuffers).toEqual([]);
    });

    it('notices a document that was removed along with its folder', async () => {
        const { store, externalRemove } = await opened(FILES, 'notes/b.md');

        externalRemove('notes');
        await vi.waitFor(() => expect(store.current?.removed).toBe(true));
        expect(store.currentPath).toBe('notes/b.md');
        expect(store.current?.text).toBe('bravo\n');
    });

    it('answers a save of a file that vanished before the store noticed with the same removed state', async () => {
        const { store, files } = await opened(FILES, 'a.md');

        store.current!.edit('mine');
        files.delete('a.md');
        await store.save();
        expect(store.current).toMatchObject({ removed: true, text: 'mine', saving: false });
    });

    it('lets go of a removed document nobody edited once another one is chosen', async () => {
        const { store, externalRemove } = await opened(FILES, 'a.md');

        externalRemove('a.md');
        await vi.waitFor(() => expect(store.current?.removed).toBe(true));
        store.select('notes/b.md');
        await vi.waitFor(() => expect(store.current?.text).toBe('bravo\n'));
        expect(store.removedBuffers).toEqual([]);
    });
});

describe('DocsStore keeps unsaved text', () => {
    it('holds an edited document while another one is open, and gives the text back', async () => {
        const { store } = await opened(FILES, 'a.md');

        store.current!.edit('alpha, unsaved');
        store.select('notes/b.md');
        await vi.waitFor(() => expect(store.current?.text).toBe('bravo\n'));
        expect(store.buffers.get('a.md')).toMatchObject({ text: 'alpha, unsaved', edited: true });

        store.select('a.md');
        expect(store.current).toMatchObject({ text: 'alpha, unsaved', edited: true });
    });

    it('lets go of a clean document when another one is chosen, and loads it fresh next time', async () => {
        const { store, files } = await opened(FILES, 'a.md');

        store.select('notes/b.md');
        await vi.waitFor(() => expect(store.current?.text).toBe('bravo\n'));
        expect(store.buffers.has('a.md')).toBe(false);

        files.set('a.md', 'alpha, changed meanwhile');
        store.select('a.md');
        await vi.waitFor(() => expect(store.current?.text).toBe('alpha, changed meanwhile'));
    });

    it('finds a conflict in a held document that changed on disk while another one was open', async () => {
        const { store, external } = await opened(FILES, 'a.md');

        store.current!.edit('alpha, unsaved');
        store.select('notes/b.md');
        await vi.waitFor(() => expect(store.current?.text).toBe('bravo\n'));
        external('a.md', 'alpha, by an agent');
        await vi.waitFor(() => expect(store.buffers.get('a.md')?.conflict).not.toBeNull());
        expect(store.buffers.get('a.md')?.text).toBe('alpha, unsaved');
    });

    it('looks again at held documents when the screen comes back', async () => {
        const { store, files } = await opened(FILES, 'a.md');

        store.current!.edit('alpha, unsaved');
        // Changed while no event could be handled, as when events are applied in one batch.
        files.set('a.md', 'alpha, by an agent');
        store.activate();
        await vi.waitFor(() => expect(store.current?.conflict).not.toBeNull());
        expect(store.current?.text).toBe('alpha, unsaved');
    });
});

describe('DocsStore new documents', () => {
    it('creates a document with no base hash, lists it and opens it', async () => {
        const { store, files, commands, ui } = await opened(FILES, 'a.md');
        const result = await store.createDocument('decisions/pricing');

        expect(result).toEqual({ ok: true, path: 'decisions/pricing.md' });
        expect(commands.at(-1)).toMatchObject({ type: 'docs.write', path: 'decisions/pricing.md', baseHash: null, content: '# Pricing\n\n' });
        expect(files.has('decisions/pricing.md')).toBe(true);
        expect(ui.docPath).toBe('decisions/pricing.md');
        await vi.waitFor(() => expect(store.current?.path).toBe('decisions/pricing.md'));
        await vi.waitFor(() => expect(store.current?.status).toBe('ready'));
    });

    it('refuses a name that is taken, or empty, without asking the daemon', async () => {
        const { store, commands } = await opened(FILES, 'a.md');

        expect(await store.createDocument('A')).toEqual({ ok: false, message: 'A.md already exists.' });
        expect(await store.createDocument('  ')).toMatchObject({ ok: false });
        expect(commands).toEqual([]);
    });

    it('says so when the daemon finds the file already there', async () => {
        const { store, files } = await opened(FILES, 'a.md');

        // Created by someone else a moment ago; the tree does not list it yet.
        files.set('fresh.md', 'x');
        expect(await store.createDocument('fresh')).toEqual({ ok: false, message: 'fresh.md already exists.' });
    });
});
