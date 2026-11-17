import { parseJson } from './json';

import type { Project, ProjectSettings, TaskStatus } from '@clowdy/protocol';
import type { Database } from 'bun:sqlite';

interface ProjectRow {
    id: string;
    name: string;
    path: string;
    task_prefix: string;
    settings: string;
    created_at: number;
}

interface StatusRow {
    id: string;
    name: string;
    category: TaskStatus['category'];
}

const toProject = (row: ProjectRow): Project => ({
    id: row.id,
    name: row.name,
    path: row.path,
    taskPrefix: row.task_prefix,
    settings: parseJson<ProjectSettings>(row.settings) ?? {},
    createdAt: row.created_at,
});

export function getProject(db: Database, id: string): Project | undefined {
    const row = db.query('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | null;

    return row ? toProject(row) : undefined;
}

export function getProjectByPath(db: Database, path: string): Project | undefined {
    const row = db.query('SELECT * FROM projects WHERE path = ?').get(path) as ProjectRow | null;

    return row ? toProject(row) : undefined;
}

export function listProjects(db: Database): Project[] {
    return (db.query('SELECT * FROM projects ORDER BY created_at, id').all() as ProjectRow[]).map(toProject);
}

export function upsertProject(db: Database, project: Project): void {
    db.query(`
        INSERT INTO projects (id, name, path, task_prefix, settings, created_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, settings = excluded.settings
    `).run(project.id, project.name, project.path, project.taskPrefix, JSON.stringify(project.settings), project.createdAt);
}

export function listStatuses(db: Database, projectId: string): TaskStatus[] {
    return db.query('SELECT id, name, category FROM task_statuses WHERE project_id = ? ORDER BY position').all(projectId) as StatusRow[];
}

export function insertStatus(db: Database, projectId: string, status: TaskStatus, position: number): void {
    db.query('INSERT INTO task_statuses (id, project_id, name, category, position) VALUES (?, ?, ?, ?, ?)')
        .run(status.id, projectId, status.name, status.category, position);
}

/** Reserves the next task number of the project. */
export function takeTaskNumber(db: Database, projectId: string): number {
    const row = db.query('UPDATE projects SET next_task_number = next_task_number + 1 WHERE id = ? RETURNING next_task_number - 1 AS number').get(projectId) as { number: number };

    return row.number;
}
