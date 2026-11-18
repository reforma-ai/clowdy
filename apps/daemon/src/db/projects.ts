import { TERMINAL_RUN_STATUSES } from '@clowdy/protocol';

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
    personal: number;
    position: number;
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
    position: row.position,
    ...(row.personal === 1 && { personal: true }),
});

const TERMINAL = TERMINAL_RUN_STATUSES.map(status => `'${ status }'`).join(', ');

/** What a project holds, for the page that manages projects: chats, tasks, and runs that are not finished. */
export interface ProjectCounts {
    chats: number;
    tasks: number;
    activeRuns: number;
}

export function getProject(db: Database, id: string): Project | undefined {
    const row = db.query('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | null;

    return row ? toProject(row) : undefined;
}

export function getProjectByPath(db: Database, path: string): Project | undefined {
    const row = db.query('SELECT * FROM projects WHERE path = ?').get(path) as ProjectRow | null;

    return row ? toProject(row) : undefined;
}

export function getPersonalProject(db: Database): Project | undefined {
    const row = db.query('SELECT * FROM projects WHERE personal = 1').get() as ProjectRow | null;

    return row ? toProject(row) : undefined;
}

export function listProjects(db: Database): Project[] {
    return (db.query('SELECT * FROM projects ORDER BY personal DESC, position, created_at, id').all() as ProjectRow[]).map(toProject);
}

/** `personal` is set when the row is made and never changes. */
export function upsertProject(db: Database, project: Project): void {
    db.query(`
        INSERT INTO projects (id, name, path, task_prefix, settings, created_at, personal, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, path = excluded.path, settings = excluded.settings, position = excluded.position
    `).run(project.id, project.name, project.path, project.taskPrefix, JSON.stringify(project.settings), project.createdAt, project.personal ? 1 : 0, project.position);
}

/** The place after the last project the person ordered; the personal space is not in the line. */
export function nextPosition(db: Database): number {
    return (db.query('SELECT COALESCE(MAX(position), 0) + 1 AS position FROM projects WHERE personal = 0').get() as { position: number }).position;
}

/** Removes the project; its chats, runs, tasks, statuses, artifacts and attachments go with it through the foreign keys. */
export function deleteProjectRow(db: Database, projectId: string): void {
    db.query('DELETE FROM projects WHERE id = ?').run(projectId);
}

export function projectCounts(db: Database): Map<string, ProjectCounts> {
    const rows = db.query(`
        SELECT p.id AS projectId,
            (SELECT COUNT(*) FROM chats WHERE project_id = p.id) AS chats,
            (SELECT COUNT(*) FROM tasks WHERE project_id = p.id) AS tasks,
            (SELECT COUNT(*) FROM runs WHERE project_id = p.id AND status NOT IN (${ TERMINAL })) AS activeRuns
        FROM projects p
    `).all() as (ProjectCounts & { projectId: string })[];

    return new Map(rows.map(({ projectId, ...counts }) => [projectId, counts]));
}

/** Whether any run of the project has not finished: its agents may be using the folder. */
export function hasUnfinishedRuns(db: Database, projectId: string): boolean {
    return db.query(`SELECT 1 FROM runs WHERE project_id = ? AND status NOT IN (${ TERMINAL }) LIMIT 1`).get(projectId) !== null;
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
