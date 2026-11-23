import { clean, parseJson } from './json';

import type { Database } from 'bun:sqlite';
import type { Task } from '@clowdy/protocol';

interface TaskRow {
    id: string;
    project_id: string;
    number: number;
    task_prefix: string;
    title: string;
    description: string;
    status_id: string;
    parent_id: string | null;
    created_by: string;
    external: string | null;
    created_at: number;
    updated_at: number;
    closed_at: number | null;
    archived_at: number | null;
}

const SELECT = 'SELECT t.*, p.task_prefix FROM tasks t JOIN projects p ON p.id = t.project_id';

const toTask = (row: TaskRow, dependsOn: string[]): Task =>
    clean({
        id: row.id,
        projectId: row.project_id,
        number: row.number,
        key: `${row.task_prefix}-${row.number}`,
        title: row.title,
        description: row.description,
        statusId: row.status_id,
        dependsOn,
        parentId: row.parent_id,
        createdBy: JSON.parse(row.created_by),
        external: parseJson(row.external),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        closedAt: row.closed_at,
        archivedAt: row.archived_at,
    }) as Task;

export function dependenciesOf(db: Database, taskId: string): string[] {
    return (
        db.query('SELECT depends_on_id FROM task_deps WHERE task_id = ? ORDER BY rowid').all(taskId) as {
            depends_on_id: string;
        }[]
    ).map(row => row.depends_on_id);
}

export function dependentsOf(db: Database, taskId: string): string[] {
    return (
        db.query('SELECT task_id FROM task_deps WHERE depends_on_id = ? ORDER BY rowid').all(taskId) as {
            task_id: string;
        }[]
    ).map(row => row.task_id);
}

/** The ids of the tasks directly inside `taskId`, in number order. */
export function childIdsOf(db: Database, taskId: string): string[] {
    return (db.query('SELECT id FROM tasks WHERE parent_id = ? ORDER BY number').all(taskId) as { id: string }[]).map(
        row => row.id
    );
}

export function getTask(db: Database, id: string): Task | undefined {
    const row = db.query(`${SELECT} WHERE t.id = ?`).get(id) as TaskRow | null;

    return row ? toTask(row, dependenciesOf(db, id)) : undefined;
}

export function getTaskByNumber(db: Database, projectId: string, number: number): Task | undefined {
    const row = db.query(`${SELECT} WHERE t.project_id = ? AND t.number = ?`).get(projectId, number) as TaskRow | null;

    return row ? toTask(row, dependenciesOf(db, row.id)) : undefined;
}

/** Every task of the project, the archived ones too: what the domain reads to walk a tree or to look a dependency up. */
export function listAllTasks(db: Database, projectId: string): Task[] {
    return withDependencies(
        db,
        projectId,
        db.query(`${SELECT} WHERE t.project_id = ? ORDER BY t.number`).all(projectId) as TaskRow[]
    );
}

/** The project's tasks that are not archived, which is what the snapshot and the board hold: the archive is read in pages (`listArchivedTasks`). */
export function listTasks(db: Database, projectId: string): Task[] {
    return withDependencies(
        db,
        projectId,
        db
            .query(`${SELECT} WHERE t.project_id = ? AND t.archived_at IS NULL ORDER BY t.number`)
            .all(projectId) as TaskRow[]
    );
}

/** Where an archived task stands in the archive's order: when it was archived, and its number, which settles a tie within one batch. */
export interface ArchivePosition {
    archivedAt: number;
    number: number;
}

/** At most `limit` archived tasks of the project, the latest archived first and the tasks of one batch by number, those after `after` when it is given. */
export function listArchivedTasks(db: Database, projectId: string, limit: number, after?: ArchivePosition): Task[] {
    const order = 'ORDER BY t.archived_at DESC, t.number ASC LIMIT ?';
    const rows = (
        after
            ? db
                  .query(
                      `${SELECT} WHERE t.project_id = ? AND (t.archived_at < ? OR (t.archived_at = ? AND t.number > ?)) ${order}`
                  )
                  .all(projectId, after.archivedAt, after.archivedAt, after.number, limit)
            : db.query(`${SELECT} WHERE t.project_id = ? AND t.archived_at IS NOT NULL ${order}`).all(projectId, limit)
    ) as TaskRow[];

    return rows.map(row => toTask(row, dependenciesOf(db, row.id)));
}

export function countArchivedTasks(db: Database, projectId: string): number {
    return (
        db.query('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND archived_at IS NOT NULL').get(projectId) as {
            n: number;
        }
    ).n;
}

/** The latest time any task of the project was archived, `0` when none was. */
export function latestArchiveTime(db: Database, projectId: string): number {
    return (
        db
            .query(
                'SELECT COALESCE(MAX(archived_at), 0) AS latest FROM tasks WHERE project_id = ? AND archived_at IS NOT NULL'
            )
            .get(projectId) as { latest: number }
    ).latest;
}

function withDependencies(db: Database, projectId: string, rows: TaskRow[]): Task[] {
    const deps = db
        .query(`
        SELECT d.task_id, d.depends_on_id FROM task_deps d JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ? ORDER BY d.rowid
    `)
        .all(projectId) as { task_id: string; depends_on_id: string }[];
    const byTask = new Map<string, string[]>();

    for (const dep of deps) {
        byTask.set(dep.task_id, [...(byTask.get(dep.task_id) ?? []), dep.depends_on_id]);
    }

    return rows.map(row => toTask(row, byTask.get(row.id) ?? []));
}

export function upsertTask(db: Database, task: Task): void {
    db.query(`
        INSERT INTO tasks (id, project_id, number, title, description, status_id, parent_id, created_by, external, created_at, updated_at, closed_at, archived_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description,
            status_id = excluded.status_id, parent_id = excluded.parent_id, external = excluded.external, updated_at = excluded.updated_at,
            closed_at = excluded.closed_at, archived_at = excluded.archived_at
    `).run(
        task.id,
        task.projectId,
        task.number,
        task.title,
        task.description,
        task.statusId,
        task.parentId ?? null,
        JSON.stringify(task.createdBy),
        task.external ? JSON.stringify(task.external) : null,
        task.createdAt,
        task.updatedAt,
        task.closedAt ?? null,
        task.archivedAt ?? null
    );
    db.query('DELETE FROM task_deps WHERE task_id = ?').run(task.id);

    for (const dependencyId of task.dependsOn) {
        db.query('INSERT INTO task_deps (task_id, depends_on_id) VALUES (?, ?)').run(task.id, dependencyId);
    }
}

export function deleteTask(db: Database, taskId: string): void {
    db.query('DELETE FROM tasks WHERE id = ?').run(taskId);
}
