import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openDatabase } from '../src/db/connection';
import { getPersonalProject, listProjects, projectCounts } from '../src/db/projects';
import { ensurePersonalProject } from '../src/domain/projects';
import { projectSnapshot, rootSnapshot } from '../src/domain/snapshots';
import { systemPrompt } from '../src/runs/prompts';
import { FolderWatchers } from '../src/skills/watch';
import { Store } from '../src/store';
import { cleanTempDirs, command, GateEngine, gateEngines, git, makeRepo, restartHarness, startHarness, tempDir, testConfig, waitFor } from './helpers';

import type { ClowdyEvent, Project, ProjectInfo } from '@clowdy/protocol';
import type { Harness } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

async function setup(overrides: Parameters<typeof startHarness>[0] = {}, gate?: GateEngine) {
    const h = await startHarness(overrides, gate ? { engines: gateEngines(gate) } : {});

    harnesses.push(h);

    return h;
}

const failure = (result: ReturnType<Harness['send']>) => {
    if (result.ok) {
        throw new Error('expected a failure');
    }

    return result.error;
};

const projectsOf = (h: Harness) => listProjects(h.store.db);
const projectOf = (h: Harness, id: string) => projectsOf(h).find(project => project.id === id) as Project;
const pathOf = (project: Project) => project.folders[0].path;
const pathsOf = (project: Project) => project.folders.map(folder => folder.path);
const count = (h: Harness, table: string) => (h.store.db.query(`SELECT COUNT(*) AS n FROM ${ table }`).get() as { n: number }).n;
const activeRuns = (h: Harness, projectId: string) => projectCounts(h.store.db).get(projectId)?.activeRuns;

/** What belongs to a project, table by table, as the foreign keys see it. */
const OWNED_BY_PROJECT: Record<string, string> = {
    task_statuses: 'project_id = ?1',
    chats: 'project_id = ?1',
    tasks: 'project_id = ?1',
    task_deps: 'task_id IN (SELECT id FROM tasks WHERE project_id = ?1)',
    chat_task_links: 'chat_id IN (SELECT id FROM chats WHERE project_id = ?1)',
    runs: 'project_id = ?1',
    run_task_links: 'run_id IN (SELECT id FROM runs WHERE project_id = ?1)',
    stream_items: 'run_id IN (SELECT id FROM runs WHERE project_id = ?1)',
    artifacts: 'project_id = ?1',
    attachments: 'project_id = ?1',
};

const rowsOf = (h: Harness, projectId: string) => Object.fromEntries(Object.entries(OWNED_BY_PROJECT).map(([table, where]) => [table, (h.store.db.query(`SELECT COUNT(*) AS n FROM ${ table } WHERE ${ where }`).get(projectId) as { n: number }).n]));
const info = async (h: Harness) => await (await h.fetch('/v1/projects/info')).json() as ProjectInfo[];
const upserted = (events: ClowdyEvent[]) => events.filter(event => event.data.type === 'project.upserted');

/** A project with a task that a gated agent is working on, so the project has an unfinished run until the gate is released. */
async function busyProject(name: string) {
    const gate = new GateEngine();
    const h = await setup({}, gate);
    const project = h.openRepo(name);
    const { task } = h.ok('task.create', { projectId: project.id, title: 'Hold the line' });

    h.ok('task.start', { taskId: task.id });
    await waitFor(() => gate.isStarted(task.key), 'the agent to start');

    return { h, gate, project, task };
}

describe('the personal space', () => {
    test('a fresh daemon has exactly one personal project, first, in a repository of its own', async () => {
        const h = await setup();
        const folder = realpathSync.native(h.config.personalDir);
        const { projects } = rootSnapshot(h.store);

        expect(projects).toEqual([expect.objectContaining({ name: 'Personal', folders: [{ id: expect.any(String), path: folder }], personal: true, position: 0, taskPrefix: 'PER', settings: {} })]);
        expect(git(folder, 'rev-parse', '--show-toplevel')).toBe(folder);
        expect(git(folder, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
        expect(git(folder, 'rev-list', '--count', 'HEAD')).toBe('1');
        expect(h.statuses(projects[0].id).map(status => status.name)).toEqual(['To do', 'In progress', 'Review', 'Done', 'Canceled']);
        expect(upserted(h.events()).map(event => event.projectId)).toEqual([projects[0].id]);

        // Opened projects come after it, whatever their own numbers are.
        h.openRepo('one');
        h.openRepo('two');
        expect(rootSnapshot(h.store).projects.map(project => project.name)).toEqual(['Personal', 'one', 'two']);
    });

    test('a second start keeps it, and makes the folder again when it was deleted', async () => {
        const first = await setup();
        const { id } = first.personal;
        const path = pathOf(first.personal);

        writeFileSync(join(path, 'notes.txt'), 'kept');
        await first.stop();

        const second = await restartHarness(first);

        harnesses.push(second);
        expect(second.personal.id).toBe(id);
        expect(projectsOf(second)).toHaveLength(1);
        expect(readFileSync(join(path, 'notes.txt'), 'utf8')).toBe('kept');
        await second.stop();
        rmSync(path, { recursive: true, force: true });

        const third = await restartHarness(second);

        harnesses.push(third);
        expect(projectsOf(third).map(project => project.id)).toEqual([id]);
        expect(git(path, 'rev-parse', '--show-toplevel')).toBe(path);
        expect(upserted(third.events()).filter(event => event.projectId === id)).toHaveLength(1);
    });

    test('a folder that exists but is not a repository becomes one', async () => {
        const first = await setup();
        const path = pathOf(first.personal);

        await first.stop();
        rmSync(join(path, '.git'), { recursive: true });

        const second = await restartHarness(first);

        harnesses.push(second);
        expect(git(path, 'rev-parse', '--show-toplevel')).toBe(path);
    });

    test('without git the folder and the row are still made', () => {
        const store = new Store(openDatabase(':memory:'));
        const config = testConfig();
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        const spawn = Bun.spawnSync;
        // What Bun does for a program that is not installed: the spawn itself throws.
        const noGit = spyOn(Bun, 'spawnSync').mockImplementation(((...args: Parameters<typeof spawn>) => {
            const cmd = args[0] as string[] | { cmd: string[] };

            if ((Array.isArray(cmd) ? cmd[0] : cmd.cmd[0]) === 'git') {
                throw new Error('Executable not found in $PATH: "git"');
            }

            return spawn(...args);
        }) as typeof spawn);

        try {
            const project = ensurePersonalProject(store, config);

            expect(project).toMatchObject({ personal: true, name: 'Personal' });
            expect(existsSync(config.personalDir)).toBe(true);
            expect(existsSync(join(config.personalDir, '.git'))).toBe(false);
            expect(getPersonalProject(store.db)?.id).toBe(project?.id);
            expect(noGit).toHaveBeenCalled();
            expect(warn).toHaveBeenCalled();
        }
        finally {
            noGit.mockRestore();
            warn.mockRestore();
            store.db.close();
        }
    });

    test('a folder that cannot be made gives no project and no error', () => {
        const store = new Store(openDatabase(':memory:'));
        const config = testConfig();
        const warn = spyOn(console, 'warn').mockImplementation(() => {});

        // A file where the folder should be.
        writeFileSync(config.personalDir, 'in the way');

        try {
            expect(ensurePersonalProject(store, config)).toBeUndefined();
            expect(listProjects(store.db)).toEqual([]);
            expect(warn).toHaveBeenCalled();
        }
        finally {
            warn.mockRestore();
            store.db.close();
        }
    });

    test('follows its folder when that moved: the person cannot choose it, so the row is pointed at the new one', () => {
        const store = new Store(openDatabase(':memory:'));
        const before = testConfig();
        const after = testConfig();

        try {
            const made = ensurePersonalProject(store, before) as Project;
            const cursor = store.headCursor();
            const moved = ensurePersonalProject(store, after) as Project;
            const folder = realpathSync.native(after.personalDir);

            expect(moved).toMatchObject({ id: made.id, folders: [{ id: made.folders[0].id, path: folder }], personal: true, position: 0 });
            expect(listProjects(store.db)).toEqual([moved]);
            expect(git(folder, 'rev-parse', '--show-toplevel')).toBe(folder);
            expect(store.eventsAfter(cursor, undefined, 10).map(event => [event.projectId, event.data.type])).toEqual([[made.id, 'project.upserted']]);

            // Starting again in the same place changes nothing.
            expect(ensurePersonalProject(store, after)).toEqual(moved);
            expect(store.headCursor()).toBe(cursor + 1);
        }
        finally {
            store.db.close();
        }
    });

    test('the system prompt calls it a personal space, and a project of one folder the folder at its path even when it is a repository', async () => {
        const h = await setup();
        const repo = h.openRepo('shop');
        const personal = systemPrompt('autopilot', h.personal);
        const regular = systemPrompt('autopilot', projectsOf(h).find(project => project.id === repo.id) as Project);

        expect(personal).toContain(`Project: Personal, the person's personal space, a folder at ${ pathOf(h.personal) } that belongs to no repository, task keys PER-<number>, project documents in .clowdy/docs/.`);
        expect(regular).toContain(`Project: shop, folder at ${ repo.path }, task keys SHO-<number>`);
        expect(regular).not.toContain('repository');
    });
});

describe('the order of projects', () => {
    test('adding hands out increasing positions', async () => {
        const h = await setup();
        const first = h.openRepo('first');

        h.openRepo('second');

        const created = h.ok('project.add', { name: 'Third' }).project as Project;

        expect(created.position).toBe(3);
        expect(projectsOf(h).map(project => [project.name, project.position])).toEqual([['Personal', 0], ['first', 1], ['second', 2], ['Third', 3]]);

        // Adding the same folders again changes nothing, and a removed place is not handed out twice.
        h.ok('project.add', { folders: [first.path] });
        h.ok('project.delete', { projectId: first.id });
        h.openRepo('fourth');
        expect(projectsOf(h).map(project => [project.name, project.position])).toEqual([['Personal', 0], ['second', 2], ['Third', 3], ['fourth', 4]]);
    });

    test('reorder puts the listed projects first, in the order given, and the others after them as they were', async () => {
        const h = await setup();
        const { a, c, d } = Object.fromEntries(['a', 'b', 'c', 'd'].map(name => [name, h.openRepo(name).id]));
        const order = () => projectsOf(h).map(project => project.name);

        const result = h.ok('project.reorder', { projectIds: [c, a] });

        expect(order()).toEqual(['Personal', 'c', 'a', 'b', 'd']);
        expect(result.projects).toEqual(projectsOf(h));
        expect(projectsOf(h).map(project => project.position)).toEqual([0, 1, 2, 3, 4]);

        h.ok('project.reorder', { projectIds: [d] });
        expect(order()).toEqual(['Personal', 'd', 'c', 'a', 'b']);
        expect(projectsOf(h).map(project => project.position)).toEqual([0, 1, 2, 3, 4]);

        // The same order again, and the empty list, change nothing.
        h.ok('project.reorder', { projectIds: [d, c, a] });
        h.ok('project.reorder', { projectIds: [] });
        expect(order()).toEqual(['Personal', 'd', 'c', 'a', 'b']);
    });

    test('the personal space stays first and at zero, a repeated id counts once, and an unknown id changes nothing', async () => {
        const h = await setup();
        const [a, b] = ['a', 'b'].map(name => h.openRepo(name).id);

        h.ok('project.reorder', { projectIds: [b, h.personal.id, b, a] });
        expect(projectsOf(h).map(project => [project.name, project.position])).toEqual([['Personal', 0], ['b', 1], ['a', 2]]);

        const cursor = h.store.headCursor();
        const refused = failure(h.send('project.reorder', { projectIds: [a, 'prj_missing'] }));

        expect(refused).toMatchObject({ code: 'invalid', message: expect.stringContaining('prj_missing') });
        expect(projectsOf(h).map(project => project.name)).toEqual(['Personal', 'b', 'a']);
        expect(h.store.headCursor()).toBe(cursor);
    });

    test('only the projects that moved are published, one event each', async () => {
        const h = await setup();
        const [a, b, c] = ['a', 'b', 'c'].map(name => h.openRepo(name).id);
        let cursor = h.store.headCursor();

        h.ok('project.reorder', { projectIds: [a, b, c] });
        expect(h.events(cursor)).toEqual([]);

        h.ok('project.reorder', { projectIds: [b] });
        expect(upserted(h.events(cursor)).map(event => event.projectId).sort()).toEqual([a, b].sort());
        expect(h.events(cursor)).toHaveLength(2);
        expect(upserted(h.events(cursor)).map(event => (event.data as { project: Project }).project.position).sort()).toEqual([1, 2]);

        cursor = h.store.headCursor();
        h.ok('project.reorder', { projectIds: [c, b, a] });
        expect(upserted(h.events(cursor)).map(event => event.projectId).sort()).toEqual([a, b, c].sort());
    });
});

describe('project.delete', () => {
    /** A project with everything that hangs from one: a chat run by the fake engine (orchestrator and its sub-agents, tasks, links, streams), a task chain, an artifact and files. */
    async function fill(h: Harness, name: string) {
        const project = h.openRepo(name);
        const { chat } = h.ok('chat.create', { projectId: project.id });
        const unsent = await (await h.fetch(`/v1/projects/${ project.id }/attachments?name=unsent.txt`, { method: 'POST', body: new Uint8Array(4).fill(1) })).json() as { id: string };
        const sent = await (await h.fetch(`/v1/projects/${ project.id }/attachments?name=sent.txt`, { method: 'POST', body: new Uint8Array(4).fill(2) })).json() as { id: string };
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Simplify the booking flow so users book in two steps', attachmentIds: [sent.id] });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to succeed', 8000);

        const first = h.ok('task.create', { projectId: project.id, title: 'First' }).task;
        const second = h.ok('task.create', { projectId: project.id, title: 'Second', dependsOn: [first.id], chatId: chat.id }).task;
        const childId = (h.store.db.query('SELECT id FROM runs WHERE parent_run_id = ? LIMIT 1').get(runId) as { id: string }).id;

        h.store.db.query('INSERT INTO artifacts (id, project_id, run_id, task_id, kind, title, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(`art_${ name }`, project.id, childId, first.id, 'file', 'Notes', 'notes.md', 1);

        return { project, chat, runId, files: [unsent.id, sent.id], tasks: [first.id, second.id] };
    }

    test('removes the chats, runs, tasks, links, streams, artifacts and files, and leaves the folder and the other projects alone', async () => {
        const h = await setup();
        const doomed = await fill(h, 'doomed');
        const other = await fill(h, 'other');
        const attachmentsRoot = join(h.config.dataDir, 'attachments');

        // The project's own files: some of them the app's, some of them the person's.
        mkdirSync(join(doomed.project.path, '.clowdy', 'docs'), { recursive: true });
        writeFileSync(join(doomed.project.path, '.clowdy', 'docs', 'plan.md'), '# Plan');
        writeFileSync(join(doomed.project.path, 'src.txt'), 'mine');

        // Everything is there to be removed, children of runs and chats of runs included.
        const before = rowsOf(h, doomed.project.id);

        expect(Object.entries(before).filter(([, rows]) => rows === 0)).toEqual([]);
        expect((h.store.db.query('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id IS NOT NULL AND project_id = ?').get(doomed.project.id) as { n: number }).n).toBeGreaterThan(0);
        expect((h.store.db.query('SELECT COUNT(*) AS n FROM runs WHERE chat_id IS NOT NULL AND project_id = ?').get(doomed.project.id) as { n: number }).n).toBeGreaterThan(0);
        doomed.files.forEach(id => expect(existsSync(join(attachmentsRoot, id))).toBe(true));

        const otherBefore = { rows: rowsOf(h, other.project.id), snapshot: JSON.stringify({ ...projectSnapshot(h.store, other.project.id), cursor: 0 }) };
        const cursor = h.store.headCursor();

        expect(h.ok('project.delete', { projectId: doomed.project.id })).toEqual({ projectId: doomed.project.id });

        // Rows: nothing of the project is left, everything of the other one is.
        expect(projectsOf(h).map(project => project.name)).toEqual(['Personal', 'other']);
        expect(Object.values(rowsOf(h, doomed.project.id)).every(rows => rows === 0)).toBe(true);
        expect(count(h, 'runs')).toBe(otherBefore.rows.runs);
        expect(count(h, 'stream_items')).toBe(otherBefore.rows.stream_items);
        expect(count(h, 'task_statuses')).toBe(2 * 5);
        expect(rowsOf(h, other.project.id)).toEqual(otherBefore.rows);
        expect(JSON.stringify({ ...projectSnapshot(h.store, other.project.id), cursor: 0 })).toBe(otherBefore.snapshot);

        // Files: the attachments of the project are gone with it, the other project's are not.
        doomed.files.forEach(id => expect(existsSync(join(attachmentsRoot, id))).toBe(false));
        other.files.forEach(id => expect(existsSync(join(attachmentsRoot, id))).toBe(true));

        // The folder and everything in it stay.
        expect(readFileSync(join(doomed.project.path, 'src.txt'), 'utf8')).toBe('mine');
        expect(readFileSync(join(doomed.project.path, '.clowdy', 'docs', 'plan.md'), 'utf8')).toBe('# Plan');
        expect(git(doomed.project.path, 'rev-parse', '--show-toplevel')).toBe(doomed.project.path);

        // One event, for that project.
        expect(h.events(cursor).map(event => [event.projectId, event.data])).toEqual([[doomed.project.id, { type: 'project.deleted' }]]);
        expect((await h.fetch(`/v1/projects/${ doomed.project.id }/snapshot`)).status).toBe(404);
        expect(failure(h.send('project.delete', { projectId: doomed.project.id })).code).toBe('not_found');
    });

    test('the folder can be added again as a new project', async () => {
        const h = await setup();
        const project = h.openRepo('again');

        h.ok('project.delete', { projectId: project.id });

        const reopened = h.ok('project.add', { folders: [project.path] }).project as Project;

        expect(reopened.id).not.toBe(project.id);
        expect(pathsOf(reopened)).toEqual([project.path]);
        expect(count(h, 'chats')).toBe(0);
    });

    test('is refused for the personal space', async () => {
        const h = await setup();
        const cursor = h.store.headCursor();

        expect(failure(h.send('project.delete', { projectId: h.personal.id }))).toMatchObject({ code: 'conflict', message: expect.stringContaining('personal') });
        expect(h.personal).toBeTruthy();
        expect(h.store.headCursor()).toBe(cursor);
    });

    test('is refused while an agent of the project is working, and goes through once it has finished', async () => {
        const { h, gate, project, task } = await busyProject('busy');
        const cursor = h.store.headCursor();

        expect(failure(h.send('project.delete', { projectId: project.id }))).toMatchObject({ code: 'conflict', message: 'The agents of this project are still working. Stop them first.' });
        expect(projectsOf(h).map(candidate => candidate.id)).toContain(project.id);
        expect(h.events(cursor).some(event => event.data.type === 'project.deleted')).toBe(false);

        gate.release(task.key);
        await waitFor(() => activeRuns(h, project.id) === 0, 'the agent to finish');
        h.ok('project.delete', { projectId: project.id });
        expect(projectsOf(h).map(candidate => candidate.id)).not.toContain(project.id);
    });

    test('forgets the skills the project had read', async () => {
        const h = await setup();
        const project = h.openRepo('watched');

        await h.fetch(`/v1/skills?projectId=${ project.id }`);

        const cursor = h.store.headCursor();

        h.ok('project.delete', { projectId: project.id });
        await Bun.sleep(100);

        expect(h.events(cursor).map(event => event.data.type)).toEqual(['project.deleted']);
        expect((h.daemon.services.skills as unknown as { projectFingerprints: Map<string, string> }).projectFingerprints.has(project.id)).toBe(false);
    });
});

describe('project.update', () => {
    test('the personal space cannot be renamed or given other folders, but keeps its settings', async () => {
        const h = await setup();
        const { id, folders } = h.personal;
        const elsewhere = makeRepo(h.config.projectsDir, 'elsewhere');

        expect(failure(h.send('project.update', { projectId: id, name: 'Mine' })).code).toBe('conflict');
        expect(failure(h.send('project.update', { projectId: id, folders: [{ path: elsewhere }] })).code).toBe('conflict');
        expect(failure(h.send('project.update', { projectId: id, folders: [{ id: folders[0].id }, { path: elsewhere }] })).code).toBe('conflict');
        expect(h.personal).toMatchObject({ name: 'Personal', folders });

        // Saying what it already is does no harm, and the settings are the person's.
        const updated = h.ok('project.update', { projectId: id, name: 'Personal', folders: [{ id: folders[0].id }], settings: { engine: 'claude', chatMode: 'semi' } }).project as Project;

        expect(updated).toMatchObject({ name: 'Personal', folders, personal: true, position: 0, settings: { engine: 'claude', chatMode: 'semi' } });
    });

    test('renames and keeps its place in the order', async () => {
        const h = await setup();
        const [a, b] = ['a', 'b'].map(name => h.openRepo(name).id);

        h.ok('project.reorder', { projectIds: [b, a] });
        h.ok('project.update', { projectId: a, name: 'Renamed' });
        expect(projectsOf(h).map(project => [project.name, project.position])).toEqual([['Personal', 0], ['b', 1], ['Renamed', 2]]);
    });

    test('a settings field set to null is cleared, the others stay, and a missing one is left alone', async () => {
        const h = await setup();
        const { id } = h.openRepo();

        h.ok('project.update', { projectId: id, settings: { maxParallelRuns: 3, engine: 'fake', chatMode: 'semi', targetBranch: 'develop', model: 'big' } });

        const cleared = h.ok('project.update', { projectId: id, settings: { engine: null, chatMode: null, model: null, targetBranch: null, maxParallelRuns: undefined } }).project as Project;

        expect(cleared.settings).toEqual({ maxParallelRuns: 3 });
        expect(Object.keys(cleared.settings)).toEqual(['maxParallelRuns']);
        expect(projectsOf(h).find(project => project.id === id)?.settings).toEqual({ maxParallelRuns: 3 });

        // Clearing what is not there is fine too.
        expect(h.ok('project.update', { projectId: id, settings: { engine: null } }).project.settings).toEqual({ maxParallelRuns: 3 });
    });

    test('over HTTP the schema accepts null for every settings field', async () => {
        const h = await setup();
        const { id } = h.openRepo();

        h.ok('project.update', { projectId: id, settings: { maxParallelRuns: 2, engine: 'fake', chatMode: 'semi', targetBranch: 'x', model: 'y' } });

        const body = command('project.update', { projectId: id, settings: { maxParallelRuns: null, engine: null, chatMode: null, targetBranch: null, model: null } });
        const response = await h.fetch('/v1/commands', { method: 'POST', body: JSON.stringify(body) });

        expect(await response.json()).toMatchObject({ ok: true, data: { project: { id, settings: {} } } });
    });

    test('keeps the folders it is told by id, adds the ones it is told by path, and keeps the order given', async () => {
        const h = await setup();
        const project = h.openRepo('web');
        const main = projectOf(h, project.id).folders[0];
        const api = realpathSync.native(makeRepo(h.config.projectsDir, 'api'));
        const notes = join(tempDir(), 'notes');

        mkdirSync(notes);

        const added = h.ok('project.update', { projectId: project.id, folders: [{ id: main.id }, { path: api }] }).project as Project;

        expect(added.folders[0]).toEqual(main);
        expect(added.folders[1]).toEqual({ id: expect.stringMatching(/^fld_/), path: api });

        // A folder that is not a repository is welcome, and a path the project has already keeps its folder.
        const grown = h.ok('project.update', { projectId: project.id, folders: [{ id: main.id }, { path: notes }, { path: api }] }).project as Project;

        expect(grown.folders.map(folder => folder.id)).toEqual([main.id, expect.stringMatching(/^fld_/), added.folders[1].id]);
        expect(pathsOf(grown)).toEqual([project.path, realpathSync.native(notes), api]);
        expect(existsSync(join(notes, '.git'))).toBe(false);

        // Removing a folder other than the main one.
        const shrunk = h.ok('project.update', { projectId: project.id, folders: [{ id: main.id }, { id: added.folders[1].id }] }).project as Project;

        expect(pathsOf(shrunk)).toEqual([project.path, api]);
        expect(pathsOf(projectSnapshot(h.store, project.id).project)).toEqual([project.path, api]);
    });

    test('new folders are checked like the ones of project.add, and another project\'s folder is fine', async () => {
        const h = await setup();
        const project = h.openRepo('home');
        const other = h.openRepo('other');
        const main = projectOf(h, project.id).folders[0];
        const cursor = h.store.headCursor();

        mkdirSync(join(project.path, 'src'));

        expect(failure(h.send('project.update', { projectId: project.id, folders: [{ id: main.id }, { path: join(project.path, 'src') }] })).message).toContain('inside');
        expect(failure(h.send('project.update', { projectId: project.id, folders: [{ id: main.id }, { id: main.id }] })).message).toContain('twice');
        expect(failure(h.send('project.update', { projectId: project.id, folders: [{ id: main.id }, { path: join(project.path, 'missing') }] })).code).toBe('invalid');
        expect(failure(h.send('project.update', { projectId: project.id, folders: [{ path: 'relative/path' }] })).code).toBe('invalid');
        expect(failure(h.send('project.update', { projectId: project.id, folders: [{ id: 'fld_nope' }] })).message).toContain('not one of the project');
        expect(failure(h.send('project.update', { projectId: project.id, folders: [] })).code).toBe('invalid');
        expect(projectOf(h, project.id).folders).toEqual([main]);
        expect(h.store.headCursor()).toBe(cursor);

        expect(pathsOf(h.ok('project.update', { projectId: project.id, folders: [{ id: main.id }, { path: other.path }] }).project)).toEqual([project.path, other.path]);
    });

    test('refuses to give a project exactly the folders another project has, in any order', async () => {
        const h = await setup();
        const shop = h.openRepo('shop');
        const api = h.openRepo('api');
        const both = h.ok('project.add', { folders: [shop.path, api.path], name: 'Both' }).project as Project;

        expect(failure(h.send('project.update', { projectId: api.id, folders: [{ path: api.path }, { path: shop.path }] }))).toMatchObject({ code: 'conflict', message: 'Both has these folders already' });
        expect(failure(h.send('project.update', { projectId: shop.id, folders: [{ path: api.path }] }))).toMatchObject({ code: 'conflict', message: 'api has these folders already' });
        // Its own set, reordered, is no clash.
        expect(pathsOf(h.ok('project.update', { projectId: both.id, folders: [{ id: both.folders[1].id }, { id: both.folders[0].id }] }).project)).toEqual([api.path, shop.path]);
    });

    test('over HTTP an entry is a folder to keep or a path to add, never both', async () => {
        const h = await setup();
        const project = h.openRepo('both');
        const main = projectOf(h, project.id).folders[0];
        const body = command('project.update', { projectId: project.id, folders: [{ id: main.id, path: project.path }] });
        const response = await h.fetch('/v1/commands', { method: 'POST', body: JSON.stringify(body) });

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ ok: false, error: { code: 'invalid' } });
    });

    test('a new main folder waits for the agents, while other folders, a rename and the same list do not', async () => {
        const { h, gate, project, task } = await busyProject('busy');
        const main = projectOf(h, project.id).folders[0];
        const next = realpathSync.native(makeRepo(h.config.projectsDir, 'next'));
        const working = { code: 'conflict', message: 'The agents of this project are still working. Stop them first.' };

        const { project: grown } = h.ok('project.update', { projectId: project.id, folders: [{ id: main.id }, { path: next }] });
        const second = grown.folders[1].id;

        expect(failure(h.send('project.update', { projectId: project.id, folders: [{ id: second }, { id: main.id }] }))).toMatchObject(working);
        expect(failure(h.send('project.update', { projectId: project.id, folders: [{ id: second }] }))).toMatchObject(working);
        expect(failure(h.send('project.update', { projectId: project.id, folders: [{ path: makeRepo(h.config.projectsDir, 'third') }] }))).toMatchObject(working);
        expect(pathsOf(projectOf(h, project.id))).toEqual([project.path, next]);

        expect(h.ok('project.update', { projectId: project.id, folders: [{ id: main.id }], name: 'Busy' }).project).toMatchObject({ name: 'Busy', folders: [main] });

        gate.release(task.key);
    });

    test('a new main folder: the documents and the project follow', async () => {
        const h = await setup();
        const project = h.openRepo('before');
        const next = makeRepo(h.config.projectsDir, 'after');
        const oldDocs = join(project.path, '.clowdy', 'docs');
        const newDocs = join(realpathSync.native(next), '.clowdy', 'docs');

        mkdirSync(oldDocs, { recursive: true });
        mkdirSync(newDocs, { recursive: true });
        writeFileSync(join(oldDocs, 'old.md'), '# Old');
        writeFileSync(join(newDocs, 'new.md'), '# New');

        const tree = async () => JSON.stringify(await (await h.fetch(`/v1/projects/${ project.id }/docs`)).json());

        expect(await tree()).toContain('old.md');

        const cursor = h.store.headCursor();
        const { project: moved } = h.ok('project.update', { projectId: project.id, folders: [{ path: next }] });

        expect(moved).toMatchObject({ id: project.id, name: 'before', folders: [{ path: realpathSync.native(next) }], position: 1 });
        expect(upserted(h.events(cursor)).map(event => pathsOf((event.data as { project: Project }).project))).toEqual([[realpathSync.native(next)]]);
        expect(await tree()).toContain('new.md');
        expect(await tree()).not.toContain('old.md');
        expect(pathsOf(projectSnapshot(h.store, project.id).project)).toEqual([realpathSync.native(next)]);
    });

    test('a project works in its new main folder, and the old folder can be added as a project of its own', async () => {
        const h = await setup();
        const project = h.openRepo('before');
        const next = makeRepo(h.config.projectsDir, 'after');

        h.ok('project.update', { projectId: project.id, folders: [{ path: next }] });

        const reopened = h.ok('project.add', { folders: [project.path] });

        expect(reopened.existing).toBeUndefined();
        expect(reopened.project.id).not.toBe(project.id);

        const { chat } = h.ok('chat.create', { projectId: project.id });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Say hello' });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to succeed', 8000);
    });
});

describe('GET /v1/projects/info', () => {
    test('needs the bearer token and does not shadow the project routes', async () => {
        const h = await setup();
        const project = h.openRepo();

        expect((await fetch(`${ h.url }/v1/projects/info`)).status).toBe(401);
        expect((await h.fetch(`/v1/projects/${ project.id }/snapshot`)).status).toBe(200);
    });

    test('lists every project in list order with each folder, its remote and branch, and the counts', async () => {
        const h = await setup();
        const repo = h.openRepo('repo');
        const bare = h.openRepo('bare');
        const gone = h.openRepo('gone');
        const plain = join(tempDir(), 'plain');
        const folderIds = (id: string) => projectOf(h, id).folders.map(folder => folder.id);

        mkdirSync(plain);
        h.ok('project.update', { projectId: bare.id, folders: [{ id: folderIds(bare.id)[0] }, { path: plain }] });
        git(repo.path, 'remote', 'add', 'origin', 'git@github.com:acme/app.git');
        rmSync(gone.path, { recursive: true, force: true });
        h.ok('chat.create', { projectId: repo.id });
        h.ok('chat.create', { projectId: repo.id });
        h.ok('task.create', { projectId: repo.id, title: 'One' });

        const projects = await info(h);
        const [personalFolder] = folderIds(h.personal.id);
        const [repoFolder] = folderIds(repo.id);
        const [bareMain, bareNotes] = folderIds(bare.id);
        const [goneFolder] = folderIds(gone.id);

        expect(projects.map(entry => entry.projectId)).toEqual(rootSnapshot(h.store).projects.map(project => project.id));
        expect(projects[0]).toEqual({ projectId: h.personal.id, folders: [{ folderId: personalFolder, exists: true, branch: 'main', chats: 0 }], chats: 0, tasks: 0, activeRuns: 0 });
        expect(projects[1]).toEqual({ projectId: repo.id, folders: [{ folderId: repoFolder, exists: true, remoteUrl: 'git@github.com:acme/app.git', branch: 'main', chats: 0 }], chats: 2, tasks: 1, activeRuns: 0 });
        expect(projects[2]).toEqual({ projectId: bare.id, folders: [{ folderId: bareMain, exists: true, branch: 'main', chats: 0 }, { folderId: bareNotes, exists: true, chats: 0 }], chats: 0, tasks: 0, activeRuns: 0 });
        expect(projects[3]).toEqual({ projectId: gone.id, folders: [{ folderId: goneFolder, exists: false, chats: 0 }], chats: 0, tasks: 0, activeRuns: 0 });
    });

    test('tells the branch a folder has checked out, and the short hash on a detached HEAD', async () => {
        const h = await setup();
        const project = h.openRepo('branches');
        const folder = projectOf(h, project.id).folders[0].id;
        const folderInfo = async () => (await info(h)).find(entry => entry.projectId === project.id)?.folders.find(entry => entry.folderId === folder);

        expect(await folderInfo()).toMatchObject({ branch: 'main' });
        expect(await folderInfo()).not.toHaveProperty('detached');

        git(project.path, 'checkout', '-q', '-b', 'feature/open-menu');
        expect(await folderInfo()).toMatchObject({ branch: 'feature/open-menu' });

        git(project.path, 'checkout', '-q', '--detach');
        expect(await folderInfo()).toMatchObject({ branch: git(project.path, 'rev-parse', '--short', 'HEAD'), detached: true });
    });

    test('has no branch for a folder that is not a repository, or that is gone', async () => {
        const h = await setup();
        const plain = h.openRepo('plain');
        const gone = h.openRepo('gone');
        const folders = (id: string) => projectOf(h, id).folders;

        // A folder in a temporary directory, away from any repository.
        const outside = join(tempDir(), 'outside');

        mkdirSync(outside);
        h.ok('project.update', { projectId: plain.id, folders: [{ path: outside }, { id: folders(plain.id)[0].id }] });
        rmSync(gone.path, { recursive: true, force: true });

        const projects = await info(h);
        const foldersOf = (id: string) => projects.find(entry => entry.projectId === id)!.folders;

        expect(foldersOf(plain.id).map(entry => entry.branch)).toEqual([undefined, 'main']);
        expect(foldersOf(gone.id)[0]).not.toHaveProperty('branch');
    });

    test('reads one project alone with ?project, and answers not found for one that is not there', async () => {
        const h = await setup();
        const first = h.openRepo('first');

        h.openRepo('second');

        const one = await (await h.fetch(`/v1/projects/info?project=${ first.id }`)).json() as ProjectInfo[];

        expect(one.map(entry => entry.projectId)).toEqual([first.id]);
        expect(one[0].folders[0]).toMatchObject({ exists: true, branch: 'main' });
        expect((await info(h)).length).toBeGreaterThan(1);
        expect((await h.fetch('/v1/projects/info?project=prj_missing')).status).toBe(404);
    });

    test('a path that is a file and not a folder does not count as one', async () => {
        const h = await setup();
        const project = h.openRepo('flat');

        rmSync(project.path, { recursive: true, force: true });
        writeFileSync(project.path, 'not a folder');

        expect((await info(h)).find(entry => entry.projectId === project.id)?.folders).toEqual([{ folderId: projectOf(h, project.id).folders[0].id, exists: false, chats: 0 }]);
    });

    test.skipIf(process.platform === 'win32')('reads the folders without stopping the daemon while git is slow', async () => {
        const h = await setup();

        ['a', 'b', 'c'].forEach(name => h.openRepo(name));

        // A git that takes 0.3 s to answer for the remote: four projects make over a second of waiting, which the daemon must spend on other work.
        const bin = tempDir('slow-git');
        const path = process.env.PATH;

        writeFileSync(join(bin, 'git'), `#!/bin/sh\n[ "$1" = remote ] && sleep 0.3\nexec ${ Bun.which('git') } "$@"\n`, { mode: 0o755 });
        process.env.PATH = `${ bin }:${ path }`;

        try {
            let ticks = 0;
            const timer = setInterval(() => ticks++, 10);
            const started = Date.now();
            const projects = await info(h);

            clearInterval(timer);
            expect(projects).toHaveLength(4);
            expect(Date.now() - started).toBeGreaterThan(900);
            // A daemon held up by git would tick only once the answer was out.
            expect(ticks).toBeGreaterThan(40);
        }
        finally {
            process.env.PATH = path;
        }
    });

    test('counts the runs that have not finished', async () => {
        const { h, gate, project, task } = await busyProject('busy');

        expect((await info(h)).find(entry => entry.projectId === project.id)).toMatchObject({ tasks: 1, activeRuns: 1 });
        gate.release(task.key);
        await waitFor(() => activeRuns(h, project.id) === 0, 'the run to finish');
        expect((await info(h)).find(entry => entry.projectId === project.id)).toMatchObject({ tasks: 1, activeRuns: 0 });
    });
});

/**
 * Writes a new file into `dir` every 50 ms until `heard` holds: the file system may not report a change made right after a watch began, and a
 * test should not depend on that moment.
 */
async function writeUntil(dir: string, heard: () => boolean, what: string): Promise<void> {
    let last = 0;
    let written = 0;

    await waitFor(() => {
        if (heard()) {
            return true;
        }

        if (Date.now() - last >= 50) {
            last = Date.now();
            writeFileSync(join(dir, `change-${ written++ }.txt`), 'x');
        }

        return false;
    }, what);
}

describe('FolderWatchers', () => {
    test('unwatch stops calling back for a folder, and the folder can be watched again', async () => {
        const watchers = new FolderWatchers(20);
        const dir = tempDir('watched');
        let calls = 0;

        try {
            watchers.watch('key', dir, () => calls++);
            await writeUntil(dir, () => calls > 0, 'the first change');

            watchers.unwatch('key', dir);
            await Bun.sleep(100);

            const seen = calls;

            writeFileSync(join(dir, 'b.txt'), 'b');
            await Bun.sleep(150);
            expect(calls).toBe(seen);

            watchers.watch('key', dir, () => calls++);
            await writeUntil(dir, () => calls > seen, 'a change after watching again');

            // Unwatching what is not watched is harmless.
            watchers.unwatch('key', join(dir, 'nothing'));
        }
        finally {
            watchers.stop();
        }
    });

    test('a folder two keys watch calls back both, and keeps calling the one left after the other unwatched', async () => {
        const watchers = new FolderWatchers(20);
        const dir = tempDir('shared');
        const calls = { one: 0, two: 0 };

        try {
            watchers.watch('one', dir, () => calls.one++);
            watchers.watch('two', dir, () => calls.two++);
            await writeUntil(dir, () => calls.one > 0 && calls.two > 0, 'both to hear the change');

            watchers.unwatch('one', dir);
            await Bun.sleep(100);

            const seen = { ...calls };

            await writeUntil(dir, () => calls.two > seen.two, 'the one left to hear the change');
            await Bun.sleep(100);
            expect(calls.one).toBe(seen.one);
        }
        finally {
            watchers.stop();
        }
    });
});
