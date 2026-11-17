import { clean, parseJson } from './json';

import type { Task } from '@clowdy/protocol';
import type { Database } from 'bun:sqlite';

interface TaskRow {
    id: string;
    project_id: string;
    number: number;
    task_prefix: string;
    title: string;
    description: string;
    status_id: string;
    created_by: string;
    external: string | null;
    created_at: number;
    updated_at: number;
}

const SELECT = 'SELECT t.*, p.task_prefix FROM tasks t JOIN projects p ON p.id = t.project_id';

const toTask = (row: TaskRow, dependsOn: string[]): Task => clean({
    id: row.id,
    projectId: row.project_id,
    number: row.number,
    key: `${ row.task_prefix }-${ row.number }`,
    title: row.title,
    description: row.description,
    statusId: row.status_id,
    dependsOn,
    createdBy: JSON.parse(row.created_by),
    external: parseJson(row.external),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
}) as Task;

export function dependenciesOf(db: Database, taskId: string): string[] {
    return (db.query('SELECT depends_on_id FROM task_deps WHERE task_id = ? ORDER BY rowid').all(taskId) as { depends_on_id: string }[]).map(row => row.depends_on_id);
}

export function dependentsOf(db: Database, taskId: string): string[] {
    return (db.query('SELECT task_id FROM task_deps WHERE depends_on_id = ? ORDER BY rowid').all(taskId) as { task_id: string }[]).map(row => row.task_id);
}

export function getTask(db: Database, id: string): Task | undefined {
    const row = db.query(`${ SELECT } WHERE t.id = ?`).get(id) as TaskRow | null;

    return row ? toTask(row, dependenciesOf(db, id)) : undefined;
}

export function getTaskByNumber(db: Database, projectId: string, number: number): Task | undefined {
    const row = db.query(`${ SELECT } WHERE t.project_id = ? AND t.number = ?`).get(projectId, number) as TaskRow | null;

    return row ? toTask(row, dependenciesOf(db, row.id)) : undefined;
}

export function listTasks(db: Database, projectId: string): Task[] {
    const rows = db.query(`${ SELECT } WHERE t.project_id = ? ORDER BY t.number`).all(projectId) as TaskRow[];
    const deps = db.query(`
        SELECT d.task_id, d.depends_on_id FROM task_deps d JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ? ORDER BY d.rowid
    `).all(projectId) as { task_id: string; depends_on_id: string }[];
    const byTask = new Map<string, string[]>();

    for (const dep of deps) {
        byTask.set(dep.task_id, [...byTask.get(dep.task_id) ?? [], dep.depends_on_id]);
    }

    return rows.map(row => toTask(row, byTask.get(row.id) ?? []));
}

export function upsertTask(db: Database, task: Task): void {
    db.query(`
        INSERT INTO tasks (id, project_id, number, title, description, status_id, created_by, external, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description,
            status_id = excluded.status_id, external = excluded.external, updated_at = excluded.updated_at
    `).run(
        task.id, task.projectId, task.number, task.title, task.description, task.statusId,
        JSON.stringify(task.createdBy), task.external ? JSON.stringify(task.external) : null, task.createdAt, task.updatedAt
    );
    db.query('DELETE FROM task_deps WHERE task_id = ?').run(task.id);

    for (const dependencyId of task.dependsOn) {
        db.query('INSERT INTO task_deps (task_id, depends_on_id) VALUES (?, ?)').run(task.id, dependencyId);
    }
}

export function deleteTask(db: Database, taskId: string): void {
    db.query('DELETE FROM tasks WHERE id = ?').run(taskId);
}
