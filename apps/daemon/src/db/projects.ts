import { TERMINAL_RUN_STATUSES } from '@clowdy/protocol';

import { parseJson, toJson } from './json';
import { deleteWorkspacesOfProject } from './workspaces';

import type { FolderSettings, Project, ProjectFolder, ProjectSettings, TaskStatus } from '@clowdy/protocol';
import type { Database } from 'bun:sqlite';

interface ProjectRow {
    id: string;
    name: string;
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

interface FolderRow {
    id: string;
    project_id: string;
    path: string;
    settings: string | null;
}

const toProject = (row: ProjectRow, folders: ProjectFolder[]): Project => ({
    id: row.id,
    name: row.name,
    folders,
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

function toFolder(row: FolderRow): ProjectFolder {
    const settings = parseJson<FolderSettings>(row.settings);

    return { id: row.id, path: row.path, ...(settings && { settings }) };
}

function foldersOf(db: Database, projectId: string): ProjectFolder[] {
    return (db.query('SELECT * FROM project_folders WHERE project_id = ? ORDER BY position').all(projectId) as FolderRow[]).map(toFolder);
}

function withFolders(db: Database, row: ProjectRow | null): Project | undefined {
    return row ? toProject(row, foldersOf(db, row.id)) : undefined;
}

export function getProject(db: Database, id: string): Project | undefined {
    return withFolders(db, db.query('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | null);
}

/** The project whose folders are exactly `paths`, in any order (a project lists a path once, so equal counts and every path found is the same set). */
export function getProjectByFolders(db: Database, paths: readonly string[]): Project | undefined {
    const wanted = [...new Set(paths)];
    const row = db.query(`
        SELECT project_id FROM project_folders
        GROUP BY project_id
        HAVING COUNT(*) = ? AND SUM(path IN (SELECT value FROM json_each(?))) = ?
        LIMIT 1
    `).get(wanted.length, JSON.stringify(wanted), wanted.length) as { project_id: string } | null;

    return row ? getProject(db, row.project_id) : undefined;
}

export function getPersonalProject(db: Database): Project | undefined {
    return withFolders(db, db.query('SELECT * FROM projects WHERE personal = 1').get() as ProjectRow | null);
}

export function listProjects(db: Database): Project[] {
    const rows = db.query('SELECT * FROM projects ORDER BY personal DESC, position, created_at, id').all() as ProjectRow[];
    const folders = new Map<string, ProjectFolder[]>();

    for (const row of db.query('SELECT * FROM project_folders ORDER BY position').all() as FolderRow[]) {
        folders.set(row.project_id, [...(folders.get(row.project_id) ?? []), toFolder(row)]);
    }

    return rows.map(row => toProject(row, folders.get(row.id) ?? []));
}

/** Writes the project and its folders, which replace the ones it had (with their settings: a folder written without its `settings` loses them). `personal` is set when the row is made and never changes. */
export function upsertProject(db: Database, project: Project): void {
    db.query(`
        INSERT INTO projects (id, name, task_prefix, settings, created_at, personal, position) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, settings = excluded.settings, position = excluded.position
    `).run(project.id, project.name, project.taskPrefix, JSON.stringify(project.settings), project.createdAt, project.personal ? 1 : 0, project.position);
    db.query('DELETE FROM project_folders WHERE project_id = ?').run(project.id);

    const insert = db.query('INSERT INTO project_folders (id, project_id, path, position, settings) VALUES (?, ?, ?, ?, ?)');

    project.folders.forEach((folder, position) => insert.run(folder.id, project.id, folder.path, position, toJson(folder.settings)));
}

/** The place after the last project the person ordered; the personal space is not in the line. */
export function nextPosition(db: Database): number {
    return (db.query('SELECT COALESCE(MAX(position), 0) + 1 AS position FROM projects WHERE personal = 0').get() as { position: number }).position;
}

/** Removes the project; its chats, runs, tasks, statuses, artifacts and attachments go with it through the foreign keys, its worktrees' rows (which have none) by hand. The worktrees stay on disk. */
export function deleteProjectRow(db: Database, projectId: string): void {
    deleteWorkspacesOfProject(db, projectId);
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
