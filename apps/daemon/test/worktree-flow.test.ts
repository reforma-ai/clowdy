import { afterAll, afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getChat } from '../src/db/chats';
import { cleanTempDirs, git, makeRepo, ScriptEngine, scriptEngines, startHarness, tempDir, waitFor } from './helpers';

import type {
    Chat,
    ChatWorkspaceRemoval,
    DocsTree,
    FolderGit,
    Project,
    ProjectFileMatch,
    ProjectInfo,
} from '@clowdy/protocol';
import type { Harness, Script } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

const finishing: Script = async function* ({ number }) {
    yield { type: 'session', sessionId: `s${number}` };
    yield { type: 'text', delta: 'Done', done: false };
    yield { type: 'text', delta: '', done: true, messageId: `m${number}` };
    yield { type: 'done', result: 'Done' };
};

/**
 * The stages of the worktree feature together, over HTTP, as the app uses them: a chat is made with a new worktree, its first turn makes it and sets it up from the
 * folder's settings, the file system, the file names, the documents, the git read and the project info all see the worktree through its `workspaceId`, and deleting the chat
 * with the worktree removes the directory and the branch once it is safe, and not before.
 */
test('a chat in a new worktree, from its creation to its deletion with the worktree', async () => {
    const engine = new ScriptEngine(finishing);
    const h = await startHarness({}, { engines: scriptEngines(engine) });

    harnesses.push(h);

    const repo = makeRepo(tempDir('worktree-flow'), 'shop');

    writeFileSync(join(repo, '.env'), 'TOKEN=1\n');

    const { project } = h.ok('project.add', { name: 'Shop', folders: [repo] }) as { project: Project };
    const [folder] = project.folders;
    const base = `/v1/projects/${project.id}`;
    const json = async <T>(path: string) => (await (await h.fetch(path)).json()) as T;
    const git_ = (workspaceId?: string) =>
        json<FolderGit>(`${base}/git?folderId=${folder.id}${workspaceId ? `&workspaceId=${workspaceId}` : ''}`);

    // The folder's settings: copy the untracked `.env`, then run a command that leaves a mark.
    h.ok('project.updateFolder', {
        projectId: project.id,
        folderId: folder.id,
        settings: { setup: { files: ['.env'], command: 'echo done > setup-done.txt' } },
    });

    const { chat } = (await h.okAsync('chat.create', { projectId: project.id, workspace: { mode: 'new' } })) as {
        chat: Chat;
    };
    const workspace = chat.workspace!;

    expect(workspace).toMatchObject({ folderId: folder.id, managed: true, ready: false });
    expect(workspace.path.endsWith(join(chat.id.slice(-8), 'shop'))).toBe(true);
    expect(chat.folderId).toBe(folder.id);
    // Nothing is on the disk yet, so the worktree is not offered as a place.
    expect(existsSync(workspace.path)).toBe(false);
    expect((await h.fetch(`${base}/fs/list?folderId=${folder.id}&workspaceId=${workspace.id}`)).status).toBe(503);

    h.ok('chat.send', { chatId: chat.id, text: 'Work on the price' });
    await waitFor(
        () =>
            (getChat(h.store.db, chat.id) as Chat).workspace?.ready === true &&
            h.run((getChat(h.store.db, chat.id) as Chat).orchestratorRunId as string).status === 'succeeded',
        'the first turn to make the worktree and end'
    );

    // The first turn made it and set it up, and the agent worked in it.
    expect(engine.turns[0]!.cwd).toBe(workspace.path);
    expect(readFileSync(join(workspace.path, '.env'), 'utf8')).toBe('TOKEN=1\n');
    expect(readFileSync(join(workspace.path, 'setup-done.txt'), 'utf8').trim()).toBe('done');
    expect(git(workspace.path, 'branch', '--show-current')).toBe(`clowdy/${chat.id.slice(-8)}`);

    // Something only the worktree has: a plan and a file, not committed.
    mkdirSync(join(workspace.path, '.briefback', 'price'), { recursive: true });
    writeFileSync(join(workspace.path, '.briefback', 'price', 'plan.md'), '# Price plan\n');

    // The places: the file system, the file names and the documents see the worktree, the folder's own checkout does not have these.
    const listed = await json<Array<{ path: string }>>(
        `${base}/fs/list?folderId=${folder.id}&workspaceId=${workspace.id}&path=`
    );
    const ownListed = await json<Array<{ path: string }>>(`${base}/fs/list?folderId=${folder.id}&path=`);

    expect(listed.map(entry => entry.path)).toContain('setup-done.txt');
    expect(ownListed.map(entry => entry.path)).not.toContain('setup-done.txt');
    expect(
        (await json<ProjectFileMatch[]>(`${base}/files?query=setup-done&workspaceId=${workspace.id}`)).map(
            match => match.path
        )
    ).toEqual(['setup-done.txt']);
    expect(await json<ProjectFileMatch[]>(`${base}/files?query=setup-done`)).toEqual([]);
    expect(
        (await json<DocsTree>(`${base}/docs?workspaceId=${workspace.id}`))[0]!.sources.map(source => source.id)
    ).toEqual(['briefback']);
    expect((await json<DocsTree>(`${base}/docs`))[0]!.sources).toEqual([]);

    // The git read lists the worktree beside the folder's own checkout (which has the untracked `.env`), each with its changes, and the info reads the branch live.
    const state = await git_();

    if (!state.isRepository) throw new Error('not a repository');

    expect(state.worktrees.map(entry => [entry.main, entry.branch, entry.dirty])).toEqual([
        [true, 'main', true],
        [false, `clowdy/${chat.id.slice(-8)}`, true],
    ]);

    const [info] = await json<ProjectInfo[]>(`/v1/projects/info?project=${project.id}`);

    expect(info.workspaces).toEqual([
        { workspaceId: workspace.id, exists: true, branch: `clowdy/${chat.id.slice(-8)}` },
    ]);

    // Not removable while there is something in it that is not committed.
    expect(await json<ChatWorkspaceRemoval>(`/v1/chats/${chat.id}/workspace`)).toMatchObject({
        removable: false,
        path: workspace.path,
        branch: `clowdy/${chat.id.slice(-8)}`,
    });
    expect(await h.sendAsync('chat.delete', { chatId: chat.id, removeWorkspace: true })).toMatchObject({
        ok: false,
        error: { code: 'conflict' },
    });
    expect(existsSync(workspace.path)).toBe(true);
    expect(getChat(h.store.db, chat.id)).toBeDefined();

    // Cleaned (the branch has no commit of its own, so it is contained in its base), it can go with the chat.
    rmSync(join(workspace.path, '.env'));
    rmSync(join(workspace.path, 'setup-done.txt'));
    rmSync(join(workspace.path, '.briefback'), { recursive: true });
    expect(await json<ChatWorkspaceRemoval>(`/v1/chats/${chat.id}/workspace`)).toMatchObject({ removable: true });

    await h.okAsync('chat.delete', { chatId: chat.id, removeWorkspace: true });

    expect(existsSync(workspace.path)).toBe(false);
    expect(
        git(repo, 'worktree', 'list', '--porcelain')
            .split('\n')
            .filter(line => line.startsWith('worktree '))
    ).toHaveLength(1);
    expect(git(repo, 'branch', '--list', `clowdy/${chat.id.slice(-8)}`)).toBe('');
    expect(getChat(h.store.db, chat.id)).toBeUndefined();
    // The folder's own checkout was never touched.
    expect(readFileSync(join(repo, '.env'), 'utf8')).toBe('TOKEN=1\n');
    expect(git(repo, 'status', '--porcelain')).toBe('?? .env');
});
