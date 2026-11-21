import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { clearChatFolders, getChat, upsertChat } from '../src/db/chats';
import { openDatabase } from '../src/db/connection';
import { getItem, itemRef, setItemRef } from '../src/db/items';
import { MIGRATIONS } from '../src/db/migrations';
import { getRun, getRunWork } from '../src/db/runs';
import { newId } from '../src/ids';
import { Store } from '../src/store';
import { cleanTempDirs, tempDir } from './helpers';

import type { Migration } from '../src/db/migrations';

afterAll(cleanTempDirs);

const tables = (db: Database) => (db.query('SELECT name FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\' ORDER BY name').all() as { name: string }[]).map(row => row.name);
const version = (db: Database) => (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;

describe('migrations', () => {
    test('a new database gets every table, WAL and foreign keys, and no backup', () => {
        const path = join(tempDir(), 'clowdy.db');
        const db = openDatabase(path);

        expect(tables(db)).toEqual(expect.arrayContaining([
            'artifacts', 'chat_task_links', 'chats', 'commands', 'events', 'project_folders', 'projects', 'run_task_links', 'runs', 'stream_items', 'task_deps', 'task_statuses', 'tasks',
        ]));
        expect(version(db)).toBe(MIGRATIONS.length);
        expect((db.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
        expect((db.query('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
        expect(existsSync(`${ path }.bak-v0`)).toBe(false);
        db.close();
    });

    test('a pending migration backs up a non-empty database first and then applies', () => {
        const path = join(tempDir(), 'clowdy.db');
        const first = openDatabase(path);

        first.query('INSERT INTO projects (id, name, task_prefix, created_at) VALUES (?, ?, ?, ?)').run('prj_1', 'Old', 'OLD', 1);
        first.close();

        const latest = MIGRATIONS.length;
        const next: Migration = { version: latest + 1, up: db => db.run('CREATE TABLE extra (id INTEGER PRIMARY KEY)') };
        const upgraded = openDatabase(path, [...MIGRATIONS, next]);

        expect(version(upgraded)).toBe(latest + 1);
        expect(tables(upgraded)).toContain('extra');
        expect(upgraded.query('SELECT name FROM projects').all()).toEqual([{ name: 'Old' }]);

        const backup = new Database(`${ path }.bak-v${ latest }`, { readonly: true });

        expect(version(backup)).toBe(latest);
        expect(tables(backup)).not.toContain('extra');
        expect(backup.query('SELECT name FROM projects').all()).toEqual([{ name: 'Old' }]);
        backup.close();
        upgraded.close();
    });

    test('version 11 moves each project\'s folder into project_folders and keeps everything that points at the project', () => {
        const path = join(tempDir(), 'clowdy.db');
        const before = openDatabase(path, MIGRATIONS.filter(migration => migration.version < 11));

        before.query('INSERT INTO projects (id, name, path, task_prefix, created_at, personal, position) VALUES (?, ?, ?, ?, ?, ?, ?)').run('prj_1', 'Shop', '/work/shop', 'SHO', 1, 0, 3);
        before.query('INSERT INTO projects (id, name, path, task_prefix, created_at, personal, position) VALUES (?, ?, ?, ?, ?, ?, ?)').run('prj_2', 'Personal', '/data/personal', 'PER', 2, 1, 0);
        before.query('INSERT INTO chats (id, project_id, title, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('cht_1', 'prj_1', 'Hello', 'autopilot', 1, 1);
        before.close();

        const db = openDatabase(path);

        expect(db.query('SELECT project_id, path, position FROM project_folders ORDER BY project_id').all()).toEqual([
            { project_id: 'prj_1', path: '/work/shop', position: 0 },
            { project_id: 'prj_2', path: '/data/personal', position: 0 },
        ]);
        expect((db.query('SELECT id FROM project_folders').all() as { id: string }[]).every(row => row.id.startsWith('fld_'))).toBe(true);
        expect((db.query('PRAGMA table_info(projects)').all() as { name: string }[]).map(column => column.name)).not.toContain('path');
        expect(db.query('SELECT id, name, position, personal FROM projects ORDER BY id').all()).toEqual([
            { id: 'prj_1', name: 'Shop', position: 3, personal: 0 },
            { id: 'prj_2', name: 'Personal', position: 0, personal: 1 },
        ]);
        expect(db.query('SELECT id FROM chats').all()).toEqual([{ id: 'cht_1' }]);
        expect((db.query('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
        expect(() => db.query('INSERT INTO projects (id, name, task_prefix, created_at, personal) VALUES (?, ?, ?, ?, ?)').run('prj_3', 'Again', 'AGA', 3, 1)).toThrow();

        // The foreign keys still hold: a project's removal takes its chats and folders along.
        db.query('DELETE FROM projects WHERE id = ?').run('prj_1');
        expect(db.query('SELECT COUNT(*) AS n FROM chats').get()).toEqual({ n: 0 });
        expect(db.query('SELECT COUNT(*) AS n FROM project_folders WHERE project_id = ?').get('prj_1')).toEqual({ n: 0 });
        db.close();
    });

    test('version 12 gives the runs of an older database a background column that reads as nothing open, and stores a list', () => {
        const path = join(tempDir(), 'clowdy.db');
        const before = openDatabase(path, MIGRATIONS.filter(migration => migration.version < 12));

        before.query('INSERT INTO projects (id, name, task_prefix, created_at) VALUES (?, ?, ?, ?)').run('prj_1', 'Old', 'OLD', 1);
        before.query('INSERT INTO runs (id, project_id, root_run_id, role, name, status, engine, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('run_1', 'prj_1', 'run_1', 'orchestrator', 'Orchestrator 01', 'succeeded', 'claude', 1);
        before.close();

        const db = openDatabase(path);

        expect(version(db)).toBe(MIGRATIONS.length);
        expect(getRun(db, 'run_1')).toMatchObject({ id: 'run_1', status: 'succeeded' });
        expect(getRun(db, 'run_1')?.background).toBeUndefined();
        db.query('UPDATE runs SET background = ? WHERE id = ?').run(JSON.stringify([{ id: 'bg-1', kind: 'command', title: 'sleep 60' }]), 'run_1');
        expect(getRun(db, 'run_1')?.background).toEqual([{ id: 'bg-1', kind: 'command', title: 'sleep 60' }]);
        db.close();
    });

    test('version 15 keeps what child runs left as history in the smaller model and drops the mailbox, the idempotency key and the outcome', () => {
        const path = join(tempDir(), 'clowdy.db');
        const before = openDatabase(path, MIGRATIONS.filter(migration => migration.version < 15));
        const background = JSON.stringify([{ id: 'bg-1', kind: 'command', title: 'sleep 60' }]);
        const run = before.query(`
            INSERT INTO runs (id, project_id, parent_run_id, root_run_id, role, origin, name, status, status_reason, engine, idempotency_key, outcome, background, created_at, finished_at)
            VALUES (?, 'prj_1', ?, ?, ?, ?, ?, ?, ?, 'claude', ?, ?, ?, 1, ?)
        `);
        const status = before.query('INSERT INTO task_statuses (id, project_id, name, category, position) VALUES (?, \'prj_1\', ?, ?, ?)');
        const task = before.query('INSERT INTO tasks (id, project_id, number, title, status_id, created_by, created_at, updated_at) VALUES (?, \'prj_1\', ?, ?, ?, \'{"kind":"user"}\', 1, 1)');
        const link = before.query('INSERT INTO run_task_links (run_id, task_id, relation) VALUES (?, ?, ?)');

        before.query('INSERT INTO projects (id, name, task_prefix, created_at) VALUES (?, ?, ?, ?)').run('prj_1', 'Old', 'OLD', 1);
        status.run('sts_todo', 'To do', 'todo', 0);
        status.run('sts_active', 'In progress', 'active', 1);
        task.run('tsk_1', 1, 'A', 'sts_todo');
        task.run('tsk_2', 2, 'B', 'sts_active');
        task.run('tsk_3', 3, 'C', 'sts_active');
        // A parent that waited for its children with background work open, a finished child, a child still at work, a verifier, a sub-agent, another
        // chat's run, and a chat's run that still waits for a slot.
        run.run('run_parent', null, 'run_parent', 'orchestrator', null, 'Orchestrator 01', 'waiting_children', 'Waiting for 1 child run', null, null, background, null);
        run.run('run_done', 'run_parent', 'run_parent', 'executor', 'spawned', 'Executor 01', 'succeeded', null, 'k1', 'done', null, 5);
        run.run('run_busy', 'run_parent', 'run_parent', 'executor', 'spawned', 'Executor 02', 'running', null, 'k2', null, background, null);
        run.run('run_check', 'run_parent', 'run_parent', 'verifier', 'spawned', 'Verifier 01', 'failed', null, 'k3', 'blocked', null, 6);
        run.run('run_native', 'run_parent', 'run_parent', 'executor', 'native', 'Explore', 'succeeded', null, null, null, null, 7);
        run.run('run_other', null, 'run_other', 'orchestrator', null, 'Orchestrator 02', 'succeeded', null, null, null, null, 8);
        run.run('run_queued', null, 'run_queued', 'orchestrator', null, 'Orchestrator 03', 'queued', 'Waiting for a free slot', null, null, null, null);
        link.run('run_parent', 'tsk_1', 'created');
        link.run('run_done', 'tsk_1', 'assigned');
        link.run('run_check', 'tsk_1', 'verifies');
        // The child still at work on two tasks: one nobody else works on, one that a chat's run waits to work on.
        link.run('run_busy', 'tsk_2', 'assigned');
        link.run('run_busy', 'tsk_3', 'assigned');
        link.run('run_queued', 'tsk_3', 'assigned');
        before.query('INSERT INTO run_mailbox (run_id, child_run_id, created_at) VALUES (?, ?, ?)').run('run_parent', 'run_done', 5);
        before.close();

        const db = openDatabase(path);
        const columns = (db.query('PRAGMA table_info(runs)').all() as { name: string }[]).map(column => column.name);
        const indexes = (db.query('SELECT name FROM sqlite_master WHERE type = \'index\'').all() as { name: string }[]).map(row => row.name);

        expect(version(db)).toBe(MIGRATIONS.length);

        // The parent is finished, with nothing open; what it had open is kept for its next message.
        expect(getRun(db, 'run_parent')).toMatchObject({ status: 'succeeded', finishedAt: expect.any(Number) });
        expect(getRun(db, 'run_parent')?.statusReason).toBeUndefined();
        expect(getRun(db, 'run_parent')?.background).toBeUndefined();
        expect(getRunWork(db, 'run_parent').lostBackground).toEqual([{ id: 'bg-1', kind: 'command', title: 'sleep 60' }]);

        // Every started child is a sub-agent now, a verifier an executor; the one still at work is stopped, the finished ones keep their end.
        expect(getRun(db, 'run_done')).toMatchObject({ role: 'executor', origin: 'native', status: 'succeeded', finishedAt: 5 });
        expect(getRun(db, 'run_busy')).toMatchObject({ role: 'executor', origin: 'native', status: 'cancelled', statusReason: 'Stopped by an update of Clowdy', finishedAt: expect.any(Number) });
        expect(getRun(db, 'run_busy')?.background).toBeUndefined();
        expect(getRun(db, 'run_check')).toMatchObject({ role: 'executor', origin: 'native', status: 'failed', finishedAt: 6 });
        expect(getRun(db, 'run_native')).toMatchObject({ role: 'executor', origin: 'native', status: 'succeeded', finishedAt: 7 });
        expect(getRun(db, 'run_other')).toMatchObject({ role: 'orchestrator', status: 'succeeded', finishedAt: 8 });
        expect(getRun(db, 'run_other')?.origin).toBeUndefined();
        expect(getRun(db, 'run_queued')).toMatchObject({ role: 'orchestrator', status: 'queued', statusReason: 'Waiting for a free slot' });
        expect(db.query('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 7 });

        // The task whose work stopped is To do again; the one a chat's run still waits to work on, and the one nobody was at, keep their column.
        expect(db.query('SELECT id, status_id FROM tasks ORDER BY id').all()).toEqual([
            { id: 'tsk_1', status_id: 'sts_todo' },
            { id: 'tsk_2', status_id: 'sts_todo' },
            { id: 'tsk_3', status_id: 'sts_active' },
        ]);

        // The links of the verifier go, the others stay; the mailbox, the idempotency key and the outcome are gone.
        expect(db.query('SELECT run_id, task_id, relation FROM run_task_links ORDER BY run_id, task_id').all()).toEqual([
            { run_id: 'run_busy', task_id: 'tsk_2', relation: 'assigned' },
            { run_id: 'run_busy', task_id: 'tsk_3', relation: 'assigned' },
            { run_id: 'run_done', task_id: 'tsk_1', relation: 'assigned' },
            { run_id: 'run_parent', task_id: 'tsk_1', relation: 'created' },
            { run_id: 'run_queued', task_id: 'tsk_3', relation: 'assigned' },
        ]);
        expect(tables(db)).not.toContain('run_mailbox');
        expect(columns).not.toContain('idempotency_key');
        expect(columns).not.toContain('outcome');
        expect(columns).toEqual(expect.arrayContaining(['cwd', 'next_prompt', 'pid', 'lost_background', 'can_stop_alone']));
        expect(indexes).not.toContain('runs_idempotency');
        expect(indexes).not.toContain('run_mailbox_pending');
        expect((db.query('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
        db.close();
    });

    test('version 16 gives the chats of an older database a parent column that reads as none, and keeps a thread\'s parent', () => {
        const path = join(tempDir(), 'clowdy.db');
        const before = openDatabase(path, MIGRATIONS.filter(migration => migration.version < 16));

        before.query('INSERT INTO projects (id, name, task_prefix, created_at) VALUES (?, ?, ?, ?)').run('prj_1', 'Old', 'OLD', 1);
        before.query('INSERT INTO chats (id, project_id, title, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('cht_1', 'prj_1', 'Hello', 'autopilot', 1, 1);
        before.close();

        const db = openDatabase(path);
        const indexes = (db.query('SELECT name FROM sqlite_master WHERE type = \'index\'').all() as { name: string }[]).map(row => row.name);

        expect(version(db)).toBe(MIGRATIONS.length);
        expect(getChat(db, 'cht_1')).toEqual({ id: 'cht_1', projectId: 'prj_1', title: 'Hello', mode: 'autopilot', createdAt: 1, updatedAt: 1 });
        expect(indexes).toContain('chats_parent');

        upsertChat(db, { id: 'cht_2', projectId: 'prj_1', title: 'Thread', mode: 'autopilot', parentChatId: 'cht_1', createdAt: 2, updatedAt: 2 });
        expect(getChat(db, 'cht_2')?.parentChatId).toBe('cht_1');

        // The parent is fixed: a later write of the chat does not move it.
        upsertChat(db, { id: 'cht_2', projectId: 'prj_1', title: 'Renamed', mode: 'autopilot', createdAt: 2, updatedAt: 3 });
        expect(getChat(db, 'cht_2')).toMatchObject({ title: 'Renamed', parentChatId: 'cht_1' });
        db.close();
    });

    test('version 17 gives the chats of an older database a folder column that reads as none, and only clearChatFolders takes a folder off', () => {
        const path = join(tempDir(), 'clowdy.db');
        const before = openDatabase(path, MIGRATIONS.filter(migration => migration.version < 17));

        before.query('INSERT INTO projects (id, name, task_prefix, created_at) VALUES (?, ?, ?, ?)').run('prj_1', 'Old', 'OLD', 1);
        before.query('INSERT INTO chats (id, project_id, title, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('cht_1', 'prj_1', 'Hello', 'autopilot', 1, 1);
        before.close();

        const db = openDatabase(path);

        expect(version(db)).toBe(MIGRATIONS.length);
        expect(getChat(db, 'cht_1')).toEqual({ id: 'cht_1', projectId: 'prj_1', title: 'Hello', mode: 'autopilot', createdAt: 1, updatedAt: 1 });

        const notes = { id: 'cht_2', projectId: 'prj_1', title: 'There', mode: 'autopilot', folderId: 'fld_notes', createdAt: 2, updatedAt: 2 } as const;
        const api = { ...notes, id: 'cht_3', folderId: 'fld_api' };

        upsertChat(db, notes);
        upsertChat(db, api);
        expect(getChat(db, 'cht_2')?.folderId).toBe('fld_notes');

        // The folder is set with the chat: an update that leaves it out does not take it off.
        upsertChat(db, { ...notes, folderId: undefined, title: 'Renamed', updatedAt: 3 });
        expect(getChat(db, 'cht_2')).toMatchObject({ title: 'Renamed', folderId: 'fld_notes' });

        // A folder that left the project is taken off its chats alone, and a stale copy of one cannot bring it back.
        expect(clearChatFolders(db, 'prj_1', ['fld_api']).map(chat => chat.id)).toEqual(['cht_2']);
        expect(clearChatFolders(db, 'prj_other', [])).toEqual([]);
        expect(getChat(db, 'cht_2')).not.toHaveProperty('folderId');
        expect(getChat(db, 'cht_3')?.folderId).toBe('fld_api');
        upsertChat(db, { ...notes, updatedAt: 4 });
        expect(getChat(db, 'cht_2')).toMatchObject({ updatedAt: 4 });
        expect(getChat(db, 'cht_2')).not.toHaveProperty('folderId');
        db.close();
    });

    test('version 18 gives the items of an older database a rewind point that reads as none, and keeps the point it is given', () => {
        const path = join(tempDir(), 'clowdy.db');
        const before = openDatabase(path, MIGRATIONS.filter(migration => migration.version < 18));

        before.query('INSERT INTO projects (id, name, task_prefix, created_at) VALUES (?, ?, ?, ?)').run('prj_1', 'Old', 'OLD', 1);
        before.query('INSERT INTO runs (id, project_id, root_run_id, role, name, summary, status, engine, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('run_1', 'prj_1', 'run_1', 'orchestrator', 'Orchestrator 01', '', 'succeeded', 'claude', 1);
        before.query('INSERT INTO stream_items (id, run_id, seq, at, body) VALUES (?, ?, ?, ?, ?)').run('itm_1', 'run_1', 1, 1, JSON.stringify({ kind: 'assistant', text: 'Old answer', done: true }));
        before.close();

        const db = openDatabase(path);

        expect(version(db)).toBe(MIGRATIONS.length);
        expect(itemRef(db, 'run_1', 1)).toBeUndefined();
        expect(getItem(db, 'run_1', 1)?.body).toEqual({ kind: 'assistant', text: 'Old answer', done: true });

        setItemRef(db, 'run_1', 1, 'msg_1');
        expect(itemRef(db, 'run_1', 1)).toBe('msg_1');
        // The point is the daemon's own: the item a client reads has no trace of it.
        expect(JSON.stringify(getItem(db, 'run_1', 1))).not.toContain('msg_1');
        db.close();
    });

    test('a failing migration rolls back, keeps the version, and leaves the backup', () => {
        const path = join(tempDir(), 'clowdy.db');

        openDatabase(path).close();

        const broken: Migration = {
            version: MIGRATIONS.length + 1,
            up(db) {
                db.run('CREATE TABLE half (id INTEGER)');
                throw new Error('boom');
            },
        };

        expect(() => openDatabase(path, [...MIGRATIONS, broken])).toThrow('boom');
        expect(existsSync(`${ path }.bak-v${ MIGRATIONS.length }`)).toBe(true);

        const db = openDatabase(path);

        expect(version(db)).toBe(MIGRATIONS.length);
        expect(tables(db)).not.toContain('half');
        db.close();
    });

    test('a table rebuild that leaves rows pointing at nothing rolls back instead of losing or orphaning them', () => {
        const path = join(tempDir(), 'clowdy.db');
        const first = openDatabase(path);

        first.query('INSERT INTO projects (id, name, task_prefix, created_at) VALUES (?, ?, ?, ?)').run('prj_1', 'Old', 'OLD', 1);
        first.query('INSERT INTO chats (id, project_id, title, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('cht_1', 'prj_1', 'Hello', 'autopilot', 1, 1);
        first.close();

        // Rebuilds `projects` but forgets to copy its rows: with foreign keys on, the drop would take the chat along; off, the chat points at nothing.
        const careless: Migration = {
            version: MIGRATIONS.length + 1,
            rebuildsTables: true,
            up(db) {
                db.run(`
                    CREATE TABLE projects_rebuilt (id TEXT PRIMARY KEY, name TEXT NOT NULL, task_prefix TEXT NOT NULL, settings TEXT NOT NULL DEFAULT '{}',
                        next_task_number INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, personal INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0);
                    DROP TABLE projects;
                    ALTER TABLE projects_rebuilt RENAME TO projects;
                `);
            },
        };

        expect(() => openDatabase(path, [...MIGRATIONS, careless])).toThrow('point at nothing');

        const db = openDatabase(path);

        expect(version(db)).toBe(MIGRATIONS.length);
        expect(db.query('SELECT id FROM projects').all()).toEqual([{ id: 'prj_1' }]);
        expect(db.query('SELECT id, project_id FROM chats').all()).toEqual([{ id: 'cht_1', project_id: 'prj_1' }]);
        db.close();
    });

    test('the run migration keeps runs of a version 1 database and gives them the new columns', () => {
        const path = join(tempDir(), 'clowdy.db');
        const old = openDatabase(path, MIGRATIONS.slice(0, 1));

        old.query('INSERT INTO projects (id, name, path, task_prefix, created_at) VALUES (?, ?, ?, ?, ?)').run('prj_1', 'Old', '/old', 'OLD', 1);
        old.query('INSERT INTO runs (id, project_id, root_run_id, role, name, status, engine, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('run_1', 'prj_1', 'run_1', 'executor', 'Executor 01', 'succeeded', 'fake', 1);
        old.close();

        const upgraded = openDatabase(path);

        expect(upgraded.query('SELECT name, origin, next_prompt, pid FROM runs').all()).toEqual([{ name: 'Executor 01', origin: null, next_prompt: null, pid: null }]);
        expect(tables(upgraded)).toContain('engine_pauses');
        upgraded.close();
    });

    test('the chat migration gives a chat that has an orchestrator the agent and model it runs on', () => {
        const path = join(tempDir(), 'clowdy.db');
        const old = openDatabase(path, MIGRATIONS.slice(0, 4));

        old.query('INSERT INTO projects (id, name, path, task_prefix, created_at) VALUES (?, ?, ?, ?, ?)').run('prj_1', 'Old', '/old', 'OLD', 1);
        old.query('INSERT INTO runs (id, project_id, root_run_id, role, name, status, engine, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('run_1', 'prj_1', 'run_1', 'orchestrator', 'Orchestrator 01', 'succeeded', 'claude', 'opus', 1);
        old.query('INSERT INTO chats (id, project_id, title, mode, orchestrator_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('cht_started', 'prj_1', 'Started', 'autopilot', 'run_1', 1, 1);
        old.query('INSERT INTO chats (id, project_id, title, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('cht_empty', 'prj_1', 'Empty', 'autopilot', 1, 1);
        old.close();

        const upgraded = openDatabase(path);

        expect(upgraded.query('SELECT id, engine, model, effort FROM chats ORDER BY id').all()).toEqual([
            { id: 'cht_empty', engine: null, model: null, effort: null },
            { id: 'cht_started', engine: 'claude', model: 'opus', effort: null },
        ]);
        expect(upgraded.query('SELECT effort FROM runs').all()).toEqual([{ effort: null }]);
        upgraded.close();
    });

    test('the personal and position migration numbers the projects of a version 4 database by creation and keeps at most one personal', () => {
        const path = join(tempDir(), 'clowdy.db');
        const old = openDatabase(path, MIGRATIONS.slice(0, 4));
        const insert = old.query('INSERT INTO projects (id, name, path, task_prefix, created_at) VALUES (?, ?, ?, ?, ?)');

        insert.run('prj_b', 'Second', '/second', 'SEC', 20);
        insert.run('prj_a', 'First', '/first', 'FIR', 10);
        // The same creation time: the id decides.
        insert.run('prj_d', 'Fourth', '/fourth', 'FOU', 30);
        insert.run('prj_c', 'Third', '/third', 'THI', 30);
        old.query('INSERT INTO task_statuses (id, project_id, name, category, position) VALUES (?, ?, ?, ?, ?)').run('sts_1', 'prj_a', 'To do', 'todo', 0);
        expect(version(old)).toBe(4);
        old.close();

        const upgraded = openDatabase(path);

        expect(version(upgraded)).toBe(MIGRATIONS.length);
        expect(upgraded.query('SELECT id, personal, position FROM projects ORDER BY position').all()).toEqual([
            { id: 'prj_a', personal: 0, position: 1 },
            { id: 'prj_b', personal: 0, position: 2 },
            { id: 'prj_c', personal: 0, position: 3 },
            { id: 'prj_d', personal: 0, position: 4 },
        ]);
        expect(upgraded.query('SELECT COUNT(*) AS n FROM task_statuses').get()).toEqual({ n: 1 });

        const personal = upgraded.query('UPDATE projects SET personal = 1 WHERE id = ?');

        personal.run('prj_a');
        expect(() => personal.run('prj_b')).toThrow(/UNIQUE/);
        upgraded.close();
    });

    test('a database newer than the daemon is refused', () => {
        const path = join(tempDir(), 'clowdy.db');
        const db = openDatabase(path);

        db.run('PRAGMA user_version = 99');
        db.close();

        expect(() => openDatabase(path)).toThrow(/newer than this daemon/);
    });
});

describe('ids', () => {
    test('carry the prefix, are 26 characters of Crockford base32, and sort by creation', () => {
        const ids = Array.from({ length: 200 }, () => newId('run'));

        for (const id of ids) {
            expect(id).toMatch(/^run_[0-9A-HJKMNP-TV-Z]{26}$/);
        }

        expect([...ids].sort()).toEqual(ids);
        expect(new Set(ids).size).toBe(200);
    });
});

describe('store', () => {
    const create = () => new Store(openDatabase(':memory:'));
    const notice = { type: 'notice', level: 'info', text: 'hi' } as const;

    test('events are inserted with the transaction and rolled back with it', () => {
        const store = create();

        expect(() => store.tx(() => {
            store.emit('prj_1', notice);
            throw new Error('abort');
        })).toThrow('abort');
        expect(store.headCursor()).toBe(0);

        store.tx(() => {
            store.emit('prj_1', notice);
            store.emit('prj_1', notice);
        });
        expect(store.eventsAfter(0, undefined, 10).map(event => event.cursor)).toEqual([1, 2]);
    });

    test('emit refuses to run outside a transaction', () => {
        expect(() => create().emit('prj_1', notice)).toThrow(/outside a transaction/);
    });

    test('afterCommit callbacks and subscribers run after commit and never after a rollback', () => {
        const store = create();
        const calls: string[] = [];

        store.subscribe(events => calls.push(`events:${ events.length }`));

        expect(() => store.tx(() => {
            store.emit('prj_1', notice);
            store.afterCommit(() => calls.push('lost'));
            throw new Error('abort');
        })).toThrow();

        store.tx(() => {
            store.emit('prj_1', notice);
            store.afterCommit(() => calls.push('after'));
            calls.push('inside');
        });

        expect(calls).toEqual(['inside', 'after', 'events:1']);
    });

    test('events can be read after a cursor, filtered by project, in order', () => {
        const store = create();

        store.tx(() => {
            store.emit('prj_a', notice);
            store.emit('prj_b', notice);
            store.emit('prj_a', notice);
        });

        expect(store.eventsAfter(1, undefined, 10).map(event => event.cursor)).toEqual([2, 3]);
        expect(store.eventsAfter(0, 'prj_a', 10).map(event => event.cursor)).toEqual([1, 3]);
        expect(store.eventsAfter(0, undefined, 2)).toHaveLength(2);
    });
});
