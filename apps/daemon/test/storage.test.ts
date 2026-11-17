import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { openDatabase } from '../src/db/connection';
import { MIGRATIONS } from '../src/db/migrations';
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
            'artifacts', 'chat_task_links', 'chats', 'commands', 'events', 'projects', 'run_task_links', 'runs', 'stream_items', 'task_deps', 'task_statuses', 'tasks',
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

        first.query('INSERT INTO projects (id, name, path, task_prefix, created_at) VALUES (?, ?, ?, ?, ?)').run('prj_1', 'Old', '/old', 'OLD', 1);
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

    test('the run migration keeps runs of a version 1 database and gives them the new columns', () => {
        const path = join(tempDir(), 'clowdy.db');
        const old = openDatabase(path, MIGRATIONS.slice(0, 1));

        old.query('INSERT INTO projects (id, name, path, task_prefix, created_at) VALUES (?, ?, ?, ?, ?)').run('prj_1', 'Old', '/old', 'OLD', 1);
        old.query('INSERT INTO runs (id, project_id, root_run_id, role, name, status, engine, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('run_1', 'prj_1', 'run_1', 'executor', 'Executor 01', 'succeeded', 'fake', 1);
        old.close();

        const upgraded = openDatabase(path);

        expect(upgraded.query('SELECT name, origin, next_prompt, pid FROM runs').all()).toEqual([{ name: 'Executor 01', origin: null, next_prompt: null, pid: null }]);
        expect(tables(upgraded)).toEqual(expect.arrayContaining(['run_mailbox', 'engine_pauses']));
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
