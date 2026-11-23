import { turnScope } from '@clowdy/protocol';
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { getChat } from '../src/db/chats';
import { saveChat } from '../src/domain/chats';
import { placeChanges, placeFile } from '../src/git/changes';
import { snapshotTree, TurnSnapshots } from '../src/git/snapshot';
import { cleanTempDirs, git, makeRepo, ScriptEngine, scriptEngines, startHarness, tempDir, waitFor } from './helpers';

import type { Chat, ChatLastRun, ClowdyEvent, GitChanges, Project, Run } from '@clowdy/protocol';
import type { Place } from '../src/domain/places';
import type { Harness, Script } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

const lines = (...text: string[]) => `${ text.join('\n') }\n`;

/** Writes files (and the folders above them) under `root`. */
function put(root: string, files: Record<string, string>): void {
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    }
}

const placeAt = (path: string): Place => ({ folder: { id: 'fld_test', path }, path });

/** A repository with three committed files, a `.gitignore` for logs and a build folder, and one more committed file in a folder. */
function work(): string {
    const path = makeRepo(tempDir('git-snapshot'), 'work');

    put(path, { '.gitignore': lines('*.log', 'build/'), 'a.ts': lines('a1', 'a2', 'a3'), 'b.ts': lines('b1', 'b2'), 'c.ts': lines('c1'), 'src/deep.ts': lines('d1', 'd2') });
    git(path, 'add', '-A');
    git(path, 'commit', '-q', '-m', 'Add the files');

    return path;
}

/** The paths a tree holds, sorted. */
const pathsOf = (path: string, tree: string) => git(path, 'ls-tree', '-r', '--name-only', tree).split('\n').filter(Boolean).sort();

/** A tree made, which the test asserts was made. */
async function treeOf(path: string): Promise<string> {
    const tree = await snapshotTree(path);

    if (!tree) throw new Error(`No tree was made of ${ path }`);

    return tree;
}

async function changesOf(path: string, start: string, end: string): Promise<Extract<GitChanges, { isRepository: true }>> {
    const answer = await placeChanges(placeAt(path), turnScope(start, end));

    if (!answer.isRepository) throw new Error('not a repository');

    return answer;
}

/** Everything of a repository that a snapshot must leave as it is: its index bytes, its refs, its status, its config, its lock and its working files. */
function fingerprint(path: string): Record<string, string> {
    const sha = (file: string) => createHash('sha1').update(readFileSync(file)).digest('hex');
    const index = join(path, '.git', 'index');

    // A status that may not write the index (`GIT_OPTIONAL_LOCKS=0`): the one a person runs refreshes the index's cached stats, and would change what is looked for.
    const read = Bun.spawnSync(['git', 'status', '--porcelain=v2', '--branch', '-uall'], { cwd: path, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    const status = read.stdout.toString();

    return {
        index: sha(index),
        indexMtime: String(statSync(index).mtimeMs),
        refs: git(path, 'for-each-ref'),
        head: git(path, 'rev-parse', 'HEAD'),
        status,
        config: sha(join(path, '.git', 'config')),
        lock: String(existsSync(join(path, '.git', 'index.lock'))),
        files: git(path, 'ls-files', '--cached', '--others', '--exclude-standard').split('\n').sort().map(file => `${ file }:${ sha(join(path, file)) }`).join(','),
    };
}

describe('snapshotTree', () => {
    test('makes the tree of the files as they are on the disk: edited, new and deleted ones, and what .gitignore hides left out', async () => {
        const path = work();
        const start = await treeOf(path);

        expect(pathsOf(path, start)).toEqual(['.gitignore', 'a.ts', 'b.ts', 'c.ts', 'src/deep.ts', 'README.md'].sort());
        // A clean tree is the tree of HEAD itself.
        expect(start).toBe(git(path, 'rev-parse', 'HEAD^{tree}'));

        put(path, { 'a.ts': lines('a1', 'A2', 'a3', 'a4'), 'new.ts': lines('n1'), 'src/more/new-deep.ts': lines('x'), 'debug.log': 'noise\n', 'build/out.js': 'out\n' });
        rmSync(join(path, 'c.ts'));

        const end = await treeOf(path);

        expect(pathsOf(path, end)).toEqual(['.gitignore', 'README.md', 'a.ts', 'b.ts', 'new.ts', 'src/deep.ts', 'src/more/new-deep.ts']);
        expect(git(path, 'diff', '--name-status', start, end).split('\n')).toEqual(['M\ta.ts', 'D\tc.ts', 'A\tnew.ts', 'A\tsrc/more/new-deep.ts']);
        // The same files make the same tree, so a turn that changed nothing is told by the two ids being one.
        expect(await treeOf(path)).toBe(end);
    });

    test('takes what a shell does: a rename, an appended line, a removed folder and a file made executable', async () => {
        const path = work();
        const start = await treeOf(path);

        for (const command of ['mv a.ts renamed.ts', 'echo more >> b.ts', 'rm -r src', 'chmod +x README.md']) {
            const shell = Bun.spawnSync(['sh', '-c', command], { cwd: path });

            expect(shell.exitCode).toBe(0);
        }

        const end = await treeOf(path);

        expect(git(path, 'diff', '--name-status', '-M', start, end).split('\n').sort()).toEqual(['D\tsrc/deep.ts', 'M\tREADME.md', 'M\tb.ts', 'R100\ta.ts\trenamed.ts'].sort());
    });

    test('takes a change the person staged or committed meanwhile as the files are, so the two trees stay what the files did', async () => {
        const path = work();
        const start = await treeOf(path);

        put(path, { 'a.ts': lines('changed'), 'fresh.ts': lines('fresh') });
        git(path, 'add', 'a.ts');
        git(path, 'commit', '-q', '-m', 'Commit the run\'s work');

        const end = await treeOf(path);

        expect(git(path, 'diff', '--name-status', start, end).split('\n')).toEqual(['M\ta.ts', 'A\tfresh.ts']);
        // Whatever happens next (a reset, a deleted file, a new branch) changes neither tree.
        git(path, 'reset', '-q', '--hard', 'HEAD~1');
        rmSync(join(path, 'fresh.ts'), { force: true });
        git(path, 'switch', '-q', '-c', 'elsewhere');
        expect(git(path, 'diff', '--name-status', start, end).split('\n')).toEqual(['M\ta.ts', 'A\tfresh.ts']);
    });

    test('leaves the repository as it found it: its index, its refs, its status, its config and the files', async () => {
        const path = work();

        put(path, { 'a.ts': lines('edited'), 'untracked.ts': lines('u'), 'ignored.log': 'x\n' });
        git(path, 'add', 'a.ts');
        put(path, { 'b.ts': lines('edited after staging') });

        const before = fingerprint(path);

        await snapshotTree(path);
        await snapshotTree(path);

        expect(fingerprint(path)).toEqual(before);
        expect(readdirSync(join(path, '.git')).filter(name => name.includes('lock') || name.startsWith('sharedindex'))).toEqual([]);
    });

    test('keeps the staged state out of it: a file staged and then edited again is the file on the disk, and nothing in the real index changes the tree', async () => {
        const path = work();

        put(path, { 'a.ts': lines('staged') });
        git(path, 'add', 'a.ts');
        put(path, { 'a.ts': lines('staged', 'and edited') });
        git(path, 'rm', '-q', '--cached', 'b.ts');

        const tree = await treeOf(path);

        expect(git(path, 'show', `${ tree }:a.ts`)).toBe('staged\nand edited');
        // A file taken out of the index but still on the disk is on the disk, which is what a run's tree says.
        expect(pathsOf(path, tree)).toContain('b.ts');
    });

    test('works in a linked worktree with its own index, and not in the checkout it was made from', async () => {
        const path = work();
        const tree = join(tempDir('git-snapshot'), 'chat-tree');

        git(path, 'worktree', 'add', '-q', '-b', 'chat-branch', tree);
        put(path, { 'in-checkout.ts': lines('only in the checkout') });

        const mainIndex = fingerprint(path).index;
        const start = await treeOf(tree);

        put(tree, { 'in-tree.ts': lines('t'), 'a.ts': lines('tree edit') });

        const end = await treeOf(tree);

        expect(pathsOf(tree, end)).toContain('in-tree.ts');
        expect(pathsOf(tree, end)).not.toContain('in-checkout.ts');
        expect(git(tree, 'diff', '--name-status', start, end).split('\n')).toEqual(['M\ta.ts', 'A\tin-tree.ts']);
        expect(fingerprint(path).index).toBe(mainIndex);
        expect(existsSync(join(path, '.git', 'worktrees'))).toBe(true);
        expect(readdirSync(join(path, '.git', 'worktrees', 'chat-tree')).filter(name => name.endsWith('.lock'))).toEqual([]);
    });

    test('works for a repository with no commit and no index yet, and for one that hashes with SHA-256', async () => {
        const fresh = join(tempDir('git-snapshot'), 'fresh');

        mkdirSync(fresh);
        git(fresh, 'init', '-q', '-b', 'main');
        put(fresh, { 'first.ts': lines('one') });
        expect(pathsOf(fresh, await treeOf(fresh))).toEqual(['first.ts']);

        const wide = join(tempDir('git-snapshot'), 'wide');

        mkdirSync(wide);
        git(wide, 'init', '-q', '-b', 'main', '--object-format=sha256');
        put(wide, { 'first.ts': lines('one') });

        const tree = await treeOf(wide);

        expect(tree).toMatch(/^[0-9a-f]{64}$/);
        expect(pathsOf(wide, tree)).toEqual(['first.ts']);
    });

    test('makes none for a folder that is no repository, one inside a repository, one that is gone, and for a git that takes too long', async () => {
        const path = work();
        const plain = tempDir('git-snapshot');

        put(plain, { 'file.txt': 'x\n' });
        put(path, { 'src/inner.ts': lines('i') });

        expect(await snapshotTree(plain)).toBeUndefined();
        expect(await snapshotTree(join(path, 'src'))).toBeUndefined();
        expect(await snapshotTree(join(plain, 'gone'))).toBeUndefined();

        const before = fingerprint(path);

        // A deadline no git process can meet: nothing is kept, the temporary index goes, and the repository is as it was.
        expect(await snapshotTree(path, 1)).toBeUndefined();
        expect(fingerprint(path)).toEqual(before);
    });

    test('leaves no temporary index behind, whether it made a tree or not', async () => {
        const folder = tempDir('git-snapshot-tmp');
        const previous = process.env.TMPDIR;
        const path = work();
        const plain = tempDir('git-snapshot');

        process.env.TMPDIR = folder;

        try {
            expect(tmpdir()).toBe(folder);
            await snapshotTree(path);
            await snapshotTree(path, 1);
            await snapshotTree(plain);
        }
        finally {
            if (previous === undefined) delete process.env.TMPDIR;
            else process.env.TMPDIR = previous;
        }

        expect(readdirSync(folder)).toEqual([]);
    });
});

describe('the scope of a run over two snapshots', () => {
    test('lists what the run changed, with its numbers and kinds, and not the files that were already changed when it started', async () => {
        const path = work();

        // What the person had in the tree before the run started: it is in both trees, so it is not the run's.
        put(path, { 'b.ts': lines('b1', 'b2', 'edited before the run'), 'scratch.ts': lines('s1', 's2') });

        const start = await treeOf(path);

        put(path, { 'a.ts': lines('a1', 'A2', 'a3', 'a4'), 'src/deep.ts': lines('d1', 'd2', 'd3'), 'created.ts': lines('n1', 'n2') });
        rmSync(join(path, 'c.ts'));

        const end = await treeOf(path);
        const answer = await changesOf(path, start, end);

        expect(answer).toMatchObject({ isRepository: true, scope: turnScope(start, end), fileCount: 4, additions: 2 + 2 + 1, deletions: 1 + 1, statsComplete: true });
        expect(answer.from).toBeUndefined();
        expect(answer.files.map(file => [file.path, file.kind, file.additions, file.deletions])).toEqual([
            ['a.ts', 'modified', 2, 1],
            ['c.ts', 'deleted', 0, 1],
            ['created.ts', 'added', 2, 0],
            ['src/deep.ts', 'modified', 1, 0],
        ]);
        expect(answer.files.some(file => file.untracked)).toBe(false);
    });

    test('reads each file\'s two sides from the trees, so it stays what the run did after the files, the branch and the repository changed', async () => {
        const path = work();
        const start = await treeOf(path);

        put(path, { 'a.ts': lines('a1', 'run edit', 'a3'), 'created.ts': lines('made by the run') });
        rmSync(join(path, 'c.ts'));

        const end = await treeOf(path);
        const place = placeAt(path);
        const scope = turnScope(start, end);
        const before = await placeChanges(place, scope);

        // The run's work is committed, then undone, then the files are edited again.
        git(path, 'add', '-A');
        git(path, 'commit', '-q', '-m', 'The run\'s work');
        git(path, 'reset', '-q', '--hard', 'HEAD~1');
        put(path, { 'a.ts': lines('something else entirely'), 'created.ts': lines('rewritten') });

        expect(await placeChanges(place, scope)).toEqual(before);
        expect(await placeFile(place, scope, 'a.ts', undefined)).toMatchObject({ state: 'text', original: lines('a1', 'a2', 'a3'), modified: lines('a1', 'run edit', 'a3') });
        expect(await placeFile(place, scope, 'created.ts', undefined)).toMatchObject({ state: 'text', original: null, modified: lines('made by the run') });
        expect(await placeFile(place, scope, 'c.ts', undefined)).toMatchObject({ state: 'text', original: lines('c1'), modified: null });
    });

    test('says the changes of a run are unavailable once git has pruned its trees', async () => {
        const path = work();
        const start = await treeOf(path);

        put(path, { 'a.ts': lines('the run was here') });

        const end = await treeOf(path);

        expect((await changesOf(path, start, end)).fileCount).toBe(1);
        git(path, 'prune', '--expire=now');
        await expect(placeChanges(placeAt(path), turnScope(start, end))).rejects.toMatchObject({ code: 'unavailable' });
        await expect(placeFile(placeAt(path), turnScope(start, end), 'a.ts', undefined)).rejects.toMatchObject({ code: 'unavailable' });
    });
});

/** A script whose turn does what `act` does in the folder it works in, then finishes. */
const doing = (act: (cwd: string, turn: number) => void | Promise<void>): Script => async function* ({ options, number }) {
    yield { type: 'session', sessionId: `s${ number }` };
    await act(options.cwd, number);
    yield { type: 'text', delta: 'Done', done: false };
    yield { type: 'text', delta: '', done: true, messageId: `m${ number }` };
    yield { type: 'done', result: 'Done' };
};

/** A daemon with a project of one repository, whose engine runs `script`. */
async function setup(script: Script, options: { repo?: string; plain?: boolean } = {}) {
    const engine = new ScriptEngine(script);
    const h = await startHarness({}, { engines: scriptEngines(engine) });

    harnesses.push(h);

    const repo = options.repo ?? (options.plain ? tempDir('git-snapshot') : work());
    const { project } = h.ok('project.add', { name: 'Shop', folders: [repo] }) as { project: Project };
    const chatOf = (chatId: string) => getChat(h.store.db, chatId) as Chat;
    const make = (workspace?: unknown) => (h.ok('chat.create', { projectId: project.id, ...(workspace !== undefined && { workspace }) }) as { chat: Chat }).chat;
    /** Sends a message and waits until the chat's run is at rest again. */
    const send = async (chat: Chat, text: string, until: Run['status'] = 'succeeded') => {
        const before = chatOf(chat.id).orchestratorRunId === undefined ? undefined : h.run(chatOf(chat.id).orchestratorRunId as string).finishedAt;

        h.ok('chat.send', { chatId: chat.id, text });
        await waitFor(() => {
            const id = chatOf(chat.id).orchestratorRunId;
            const run = id ? h.run(id) : undefined;

            return run?.status === until && run.finishedAt !== before;
        }, `the turn on "${ text }" to end as ${ until }`);
    };
    const read = async (chat: Chat, scope: string, workspaceId?: string) => {
        const query = `?folderId=${ project.folders[0].id }${ workspaceId ? `&workspaceId=${ workspaceId }` : '' }&scope=${ scope }`;

        return await (await h.fetch(`/v1/projects/${ project.id }/git/changes${ query }`)).json() as GitChanges;
    };

    return { h, engine, repo, project, chatOf, make, send, read, folder: project.folders[0] };
}

const lastRunOf = (chat: Chat): ChatLastRun => {
    if (!chat.lastRun) throw new Error('the chat has no last run');

    return chat.lastRun;
};

describe('a chat\'s turn', () => {
    test('keeps the two trees on the chat when it edits and adds files, and publishes the chat with them', async () => {
        const { h, repo, chatOf, make, send, read, project } = await setup(doing((cwd) => {
            put(cwd, { 'a.ts': lines('a1', 'by the agent', 'a3'), 'agent-made.ts': lines('new', 'file') });
        }));
        const chat = make();

        // Work the person left in the tree before the turn.
        put(repo, { 'b.ts': lines('b1', 'b2', 'the person was here') });

        const cursor = h.events().at(-1)?.cursor ?? 0;

        await send(chat, 'Edit two files and add one');

        const run = lastRunOf(chatOf(chat.id));

        expect(run.startTree).not.toBe(run.endTree);
        expect(run.seq).toBeGreaterThan(0);
        expect(run.at).toBeGreaterThan(0);

        const answer = await read(chat, turnScope(run.startTree, run.endTree)) as Extract<GitChanges, { isRepository: true }>;

        expect(answer.files.map(file => file.path)).toEqual(['a.ts', 'agent-made.ts']);

        // The change reached a client that listens: the chat was published with its last run once the trees were known.
        const upserts = h.events(cursor).flatMap((event: ClowdyEvent) => (event.data.type === 'chat.upserted' && event.data.chat.id === chat.id ? [event.data.chat] : []));

        expect(upserts.some(published => published.lastRun !== undefined)).toBe(true);
        expect(upserts.at(-1)?.lastRun).toEqual(run);
        expect(project.id).toBe(chat.projectId);
        // The repository's own index was not what the trees were made in.
        expect(git(repo, 'status', '--porcelain').split('\n').map(line => line.trim()).sort()).toEqual(['M a.ts', 'M b.ts', '?? agent-made.ts'].sort());
    });

    test('takes the next turn\'s record in place of the last one, and forgets it when that turn changes nothing', async () => {
        const { h, chatOf, make, send } = await setup(doing((cwd, turn) => {
            if (turn === 1) put(cwd, { 'a.ts': lines('first turn') });
            if (turn === 3) put(cwd, { 'a.ts': lines('third turn') });
        }));
        const chat = make();

        await send(chat, 'First');

        const first = lastRunOf(chatOf(chat.id));

        // A turn that changes nothing: the earlier turn is not the last one any more, so its record goes, and the chat is published without it.
        const cursor = h.events().at(-1)?.cursor ?? 0;

        await send(chat, 'Second');
        expect(chatOf(chat.id).lastRun).toBeUndefined();
        expect(h.events(cursor).some(event => event.data.type === 'chat.upserted' && event.data.chat.id === chat.id && event.data.chat.lastRun === undefined)).toBe(true);

        await send(chat, 'Third');

        const third = lastRunOf(chatOf(chat.id));

        expect(third.startTree).toBe(first.endTree);
        expect(third.endTree).not.toBe(first.endTree);
        expect(third.seq).toBeGreaterThan(first.seq);
    });

    test('keeps nothing for a folder that is no repository, and makes no snapshot for a turn that cannot have one', async () => {
        const { chatOf, make, send } = await setup(doing((cwd) => {
            put(cwd, { 'notes.txt': 'written\n' });
        }), { plain: true });
        const chat = make();

        await send(chat, 'Write a note');
        expect(chatOf(chat.id).lastRun).toBeUndefined();
    });

    test('keeps what a stopped turn changed, since the files changed all the same', async () => {
        const hold: Script = async function* ({ options, number, signal }) {
            yield { type: 'session', sessionId: `s${ number }` };
            put(options.cwd, { 'half-done.ts': lines('written before the stop') });
            yield { type: 'text', delta: 'working', done: false };

            if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));

            throw new Error('stopped');
        };
        const { h, repo, chatOf, make, read } = await setup(hold);
        const chat = make();

        h.ok('chat.send', { chatId: chat.id, text: 'Start and be stopped' });
        await waitFor(() => existsSync(join(repo, 'half-done.ts')), 'the agent to write its file');

        const runId = chatOf(chat.id).orchestratorRunId as string;

        h.ok('run.cancel', { runId });
        await waitFor(() => chatOf(chat.id).lastRun, 'the stopped turn to be measured');

        const run = lastRunOf(chatOf(chat.id));
        const answer = await read(chat, turnScope(run.startTree, run.endTree)) as Extract<GitChanges, { isRepository: true }>;

        expect(answer.files.map(file => file.path)).toEqual(['half-done.ts']);
    });

    test('measures each turn of a session that waits for background work by itself: the first by its own start and end, a message sent into it as a turn of its own', async () => {
        const background = { id: 'bg-1', kind: 'command' as const, title: 'sleep 60' };
        const script: Script = async function* (turn) {
            yield { type: 'session', sessionId: 's-1' };
            put(turn.options.cwd, { 'first-turn.ts': lines('first') });
            yield { type: 'text', delta: 'Started it', done: true };
            yield { type: 'background', items: [background] };
            yield { type: 'done', result: 'Started it' };

            const message = await turn.received();

            if (message === undefined) return;

            put(turn.options.cwd, { 'second-turn.ts': lines('second') });
            yield { type: 'text', delta: `Heard: ${ message }`, done: true };
            yield { type: 'done', result: 'Heard' };
            await turn.received();
        };
        const engine = new ScriptEngine(script);

        engine.sendAnswer = () => true;

        const h = await startHarness({}, { engines: scriptEngines(engine) });

        harnesses.push(h);

        const repo = work();
        const { project } = h.ok('project.add', { name: 'Shop', folders: [repo] }) as { project: Project };
        const chat = (h.ok('chat.create', { projectId: project.id }) as { chat: Chat }).chat;
        const chatOf = () => getChat(h.store.db, chat.id) as Chat;
        const filesOf = async (run: ChatLastRun) => {
            const query = `?folderId=${ project.folders[0].id }&scope=${ turnScope(run.startTree, run.endTree) }`;
            const answer = await (await h.fetch(`/v1/projects/${ project.id }/git/changes${ query }`)).json() as Extract<GitChanges, { isRepository: true }>;

            return answer.files.map(file => file.path);
        };

        h.ok('chat.send', { chatId: chat.id, text: 'Start it' });
        await waitFor(() => chatOf().orchestratorRunId && h.run(chatOf().orchestratorRunId as string).status === 'waiting_background', 'the run to wait for background work');

        const runId = chatOf().orchestratorRunId as string;
        const first = await waitFor(() => chatOf().lastRun, 'the first turn to be measured');

        expect(await filesOf(first)).toEqual(['first-turn.ts']);

        h.ok('chat.send', { chatId: chat.id, text: 'How is it going' });
        await waitFor(() => engine.sent.length === 1 && h.run(runId).status === 'waiting_background' && chatOf().lastRun?.seq !== first.seq, 'the message to be answered and measured');

        const second = lastRunOf(chatOf());

        expect(await filesOf(second)).toEqual(['second-turn.ts']);
        expect(second.startTree).toBe(first.endTree);
        expect(second.seq).toBeGreaterThan(first.seq);
        expect(engine.turns).toHaveLength(1);
    });

    test('measures a chat in a worktree in that worktree, and not the checkout it was made from', async () => {
        const repo = work();
        const tree = join(tempDir('git-snapshot'), 'chat-tree');

        git(repo, 'worktree', 'add', '-q', '-b', 'chat-branch', tree);

        const { h, chatOf, make, send, read } = await setup(doing((cwd) => {
            put(cwd, { 'in-tree.ts': lines('made in the worktree') });
        }), { repo });
        const chat = make({ mode: 'existing', path: tree });

        // The checkout has an edit of its own while the chat works.
        put(repo, { 'in-checkout.ts': lines('not the chat\'s') });
        await send(chat, 'Work in the worktree');

        const run = lastRunOf(chatOf(chat.id));
        const answer = await read(chat, turnScope(run.startTree, run.endTree), chat.workspace?.id) as Extract<GitChanges, { isRepository: true }>;

        expect(answer.files.map(file => file.path)).toEqual(['in-tree.ts']);
        expect(h.run(chatOf(chat.id).orchestratorRunId as string).status).toBe('succeeded');
    });

    test('measures two chats of one place each by its own turn, and a turn that overlaps another shows that one\'s edits as well', async () => {
        let open!: () => void;
        const gate = new Promise<void>((resolve) => {
            open = resolve;
        });
        const script: Script = async function* ({ options, number }) {
            yield { type: 'session', sessionId: `s${ number }` };

            if (options.prompt.includes('slow work')) {
                // The slow chat's turn is open while the quick one's starts, edits and ends; it edits last.
                await gate;
                put(options.cwd, { 'slow-edit.ts': lines('slow') });
            }
            else {
                put(options.cwd, { 'quick-edit.ts': lines('quick') });
            }

            yield { type: 'text', delta: 'Done', done: false };
            yield { type: 'text', delta: '', done: true, messageId: `m${ number }` };
            yield { type: 'done', result: 'Done' };
        };
        const { h, engine, chatOf, make, send, read } = await setup(script);
        const slow = make();
        const quick = make();

        h.ok('chat.send', { chatId: slow.id, text: 'slow work' });
        await waitFor(() => engine.turns.length === 1, 'the slow turn to start');
        await send(quick, 'quick work');
        open();
        await waitFor(() => chatOf(slow.id).lastRun, 'the slow turn to be measured');

        const files = async (run: ChatLastRun) => ((await read(quick, turnScope(run.startTree, run.endTree))) as Extract<GitChanges, { isRepository: true }>).files.map(file => file.path);

        expect(await files(lastRunOf(chatOf(quick.id)))).toEqual(['quick-edit.ts']);
        expect(await files(lastRunOf(chatOf(slow.id)))).toEqual(['quick-edit.ts', 'slow-edit.ts']);
    });

    test('is published with the last run whatever copy of the chat is saved, so a stale copy cannot take it away', async () => {
        const { h, chatOf, make, send } = await setup(doing((cwd) => {
            put(cwd, { 'a.ts': lines('changed') });
        }));
        const chat = make();
        const stale = chatOf(chat.id);

        await send(chat, 'Change a file');

        const run = lastRunOf(chatOf(chat.id));
        const cursor = h.events().at(-1)?.cursor ?? 0;

        h.store.tx(() => saveChat(h.store, { ...stale, title: 'Renamed from a stale copy' }));
        expect(chatOf(chat.id)).toMatchObject({ title: 'Renamed from a stale copy', lastRun: run });

        const published = h.events(cursor).flatMap(event => (event.data.type === 'chat.upserted' ? [event.data.chat] : []));

        expect(published.at(-1)).toMatchObject({ title: 'Renamed from a stale copy', lastRun: run });
    });
});

describe('TurnSnapshots', () => {
    /** A store with a chat and its run, for the class on its own with a snapshot function the test controls. */
    async function bare(snapshot: (cwd: string) => Promise<string | undefined>, options: { startWaitMs?: number; endWaitMs?: number } = {}) {
        const { h, make, chatOf } = await setup(doing(() => undefined), { plain: true });
        const chat = make();

        h.ok('chat.send', { chatId: chat.id, text: 'Make the run' });
        await waitFor(() => chatOf(chat.id).orchestratorRunId, 'the run');

        const runId = chatOf(chat.id).orchestratorRunId as string;

        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to end');

        return { h, chat, chatOf, runId, snapshots: new TurnSnapshots(h.store, { snapshot, ...options }) };
    }

    const A = 'a'.repeat(40);
    const B = 'b'.repeat(40);

    test('does not hold a turn\'s start longer than the wait, and still keeps the pair when the slow tree comes in', async () => {
        let release!: (tree: string) => void;
        const slow = new Promise<string>((resolve) => {
            release = resolve;
        });
        const trees = [slow, Promise.resolve(B)];
        const { chat, chatOf, runId, snapshots } = await bare(() => trees.shift() as Promise<string>, { startWaitMs: 30, endWaitMs: 30 });
        const turn = snapshots.begin(runId, '/somewhere');

        expect(turn).toBeDefined();

        const before = performance.now();

        await turn?.started();
        expect(performance.now() - before).toBeLessThan(500);

        // The end waits as long, and comes back before the start tree is there; the pair is kept when it is.
        const ending = performance.now();

        await turn?.end();
        expect(performance.now() - ending).toBeLessThan(500);
        expect(chatOf(chat.id).lastRun).toBeUndefined();
        release(A);
        await waitFor(() => chatOf(chat.id).lastRun, 'the pair to be kept');
        expect(chatOf(chat.id).lastRun).toMatchObject({ startTree: A, endTree: B });
    });

    test('keeps nothing when either tree could not be made, when they are one tree, and asked twice does it once', async () => {
        const calls: string[] = [];
        const answers: (string | undefined)[] = [A, A];
        const { chat, chatOf, runId, snapshots } = await bare(async (cwd) => {
            calls.push(cwd);

            return answers.shift();
        });
        const unchanged = snapshots.begin(runId, '/somewhere');

        await unchanged?.end();
        await unchanged?.end();
        expect(calls).toHaveLength(2);
        expect(chatOf(chat.id).lastRun).toBeUndefined();

        // A start that failed is not measured at the end: one failed attempt is not tried twice.
        answers.push(undefined);

        const failed = snapshots.begin(runId, '/somewhere');

        await failed?.end();
        expect(calls).toHaveLength(3);
        expect(chatOf(chat.id).lastRun).toBeUndefined();

        // An end that failed leaves the earlier record gone as well.
        answers.push(A, undefined);

        const lost = snapshots.begin(runId, '/somewhere');

        await lost?.end();
        expect(chatOf(chat.id).lastRun).toBeUndefined();
    });

    test('measures only a chat\'s own orchestrator: no run, a run with a folder of its own and a sub-agent\'s run have none', async () => {
        const { h, chat, chatOf, runId, snapshots } = await bare(async () => A);

        expect(snapshots.begin('run_unknown', '/somewhere')).toBeUndefined();

        // A run that was given a working directory of its own (a thread's `cwd`) works elsewhere than its chat's place.
        h.store.db.query('UPDATE runs SET cwd = ? WHERE id = ?').run('/elsewhere', runId);
        expect(snapshots.begin(runId, '/somewhere')).toBeUndefined();
        h.store.db.query('UPDATE runs SET cwd = NULL WHERE id = ?').run(runId);
        expect(snapshots.begin(runId, '/somewhere')).toBeDefined();
        // A sub-agent's run (an executor) belongs to no chat's own turn.
        h.store.db.query('UPDATE runs SET role = ? WHERE id = ?').run('executor', runId);
        expect(snapshots.begin(runId, '/somewhere')).toBeUndefined();
        expect(chatOf(chat.id).lastRun).toBeUndefined();
    });
});
