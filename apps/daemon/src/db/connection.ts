import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

import { MIGRATIONS } from './migrations';

import type { Migration } from './migrations';

const MEMORY = ':memory:';

/** Opens the database (WAL, foreign keys) and brings its schema up to date. */
export function openDatabase(path: string, migrations: Migration[] = MIGRATIONS): Database {
    if (path !== MEMORY) {
        mkdirSync(dirname(path), { recursive: true });
    }

    const db = new Database(path, { create: true });

    if (path !== MEMORY) {
        db.run('PRAGMA journal_mode = WAL');
        db.run('PRAGMA synchronous = NORMAL');
    }

    db.run('PRAGMA foreign_keys = ON');
    db.run('PRAGMA busy_timeout = 5000');
    migrate(db, migrations, path);

    return db;
}

/**
 * Applies pending migrations, each in its own transaction. A database that already holds data (version > 0) is
 * copied to `<path>.bak-v<version>` first, so a bad migration never costs the user's history.
 */
function migrate(db: Database, migrations: Migration[], path: string): void {
    const current = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
    const latest = migrations.at(-1)?.version ?? 0;

    if (current > latest) {
        throw new Error(`The database is at version ${ current }, newer than this daemon understands (${ latest }). Update the daemon.`);
    }

    const pending = migrations.filter(migration => migration.version > current);

    if (pending.length === 0) {
        return;
    }

    if (current > 0 && path !== MEMORY) {
        const backup = `${ path }.bak-v${ current }`;

        rmSync(backup, { force: true });
        db.run(`VACUUM INTO '${ backup.replaceAll('\'', '\'\'') }'`);
    }

    for (const migration of pending) {
        // The pragma does nothing inside a transaction.
        if (migration.rebuildsTables) {
            db.run('PRAGMA foreign_keys = OFF');
        }

        try {
            db.transaction(() => {
                migration.up(db);

                if (migration.rebuildsTables && db.query('PRAGMA foreign_key_check').all().length > 0) {
                    throw new Error(`Migration ${ migration.version } left rows that point at nothing`);
                }

                db.run(`PRAGMA user_version = ${ migration.version }`);
            })();
        }
        finally {
            if (migration.rebuildsTables) {
                db.run('PRAGMA foreign_keys = ON');
            }
        }
    }
}
