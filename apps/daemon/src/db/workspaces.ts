import type { ChatWorkspace } from '@clowdy/protocol';
import type { Database } from 'bun:sqlite';

/** A worktree a chat works in, as the `workspaces` table holds it. `ChatWorkspace` is what clients see of it (`toChatWorkspace`). */
export interface WorkspaceRecord {
    id: string;
    projectId: string;
    /** The folder of the project it is a checkout of. */
    folderId: string;
    /** Absolute, as the machine writes it. */
    path: string;
    /** The branch it was made or picked with; absent for a worktree on a detached HEAD. */
    branch?: string;
    /** The ref a new worktree starts from (`origin/main`), kept for the check that its work was merged; absent for a worktree that was found, not made. */
    base?: string;
    /** Clowdy made it, under the workspaces folder, so Clowdy may remove it. */
    managed: boolean;
    /** The worktree exists and is set up; false until the first turn made it. */
    ready: boolean;
    createdAt: number;
}

interface WorkspaceRow {
    id: string;
    project_id: string;
    folder_id: string;
    path: string;
    branch: string | null;
    base: string | null;
    managed: number;
    ready: number;
    created_at: number;
}

const toRecord = (row: WorkspaceRow): WorkspaceRecord => ({
    id: row.id,
    projectId: row.project_id,
    folderId: row.folder_id,
    path: row.path,
    ...(row.branch !== null && { branch: row.branch }),
    ...(row.base !== null && { base: row.base }),
    managed: row.managed === 1,
    ready: row.ready === 1,
    createdAt: row.created_at,
});

/** What clients see of a worktree: the part that matters to a chat (`Chat.workspace`). */
export const toChatWorkspace = (record: WorkspaceRecord): ChatWorkspace => ({
    id: record.id,
    folderId: record.folderId,
    path: record.path,
    ...(record.branch !== undefined && { branch: record.branch }),
    managed: record.managed,
    ready: record.ready,
});

/**
 * The columns of a workspace a chat is read with, next to the chat's own (`LEFT JOIN workspaces w ON w.id = chats.workspace_id`), so a chat is published with its
 * worktree and no second read is needed. All `NULL` for a chat that has none.
 */
export const EMBEDDED_WORKSPACE = 'w.id AS w_id, w.folder_id AS w_folder_id, w.path AS w_path, w.branch AS w_branch, w.managed AS w_managed, w.ready AS w_ready';

/** The joined columns (`EMBEDDED_WORKSPACE`) of a chat row; absent from a row that was not read with the join (`UPDATE ... RETURNING`), which reads as no workspace. */
export interface EmbeddedWorkspaceRow {
    w_id?: string | null;
    w_folder_id?: string | null;
    w_path?: string | null;
    w_branch?: string | null;
    w_managed?: number | null;
    w_ready?: number | null;
}

/** The worktree a chat row was read with, or nothing for a chat that has none. */
export function embeddedWorkspace(row: EmbeddedWorkspaceRow): ChatWorkspace | undefined {
    if (row.w_id == null || row.w_folder_id == null || row.w_path == null) {
        return undefined;
    }

    return {
        id: row.w_id,
        folderId: row.w_folder_id,
        path: row.w_path,
        ...(row.w_branch != null && { branch: row.w_branch }),
        managed: row.w_managed === 1,
        ready: row.w_ready === 1,
    };
}

export function getWorkspace(db: Database, id: string): WorkspaceRecord | undefined {
    const row = db.query('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | null;

    return row ? toRecord(row) : undefined;
}

/** Every worktree of the project's chats, oldest first. */
export function listWorkspacesOfProject(db: Database, projectId: string): WorkspaceRecord[] {
    return (db.query('SELECT * FROM workspaces WHERE project_id = ? ORDER BY created_at, id').all(projectId) as WorkspaceRow[]).map(toRecord);
}

/** A worktree row of a project, and whether a chat still points at it (an archived chat counts). */
export interface WorkspaceUse {
    record: WorkspaceRecord;
    inUse: boolean;
}

/**
 * Every worktree row of the project, oldest first, each with whether a chat points at it: the rows a client can ask about. A row nobody points at is one the new-chat page
 * opened (`workspace.open`) before its first message, or one left by a chat that lost its folder; the caller decides which of them are worth reading.
 */
export function listWorkspaceUses(db: Database, projectId: string): WorkspaceUse[] {
    return (db.query(`
        SELECT *, EXISTS (SELECT 1 FROM chats WHERE chats.workspace_id = workspaces.id) AS in_use FROM workspaces WHERE project_id = ? ORDER BY created_at, id
    `).all(projectId) as Array<WorkspaceRow & { in_use: number }>).map(row => ({ record: toRecord(row), inUse: row.in_use === 1 }));
}

/** The ids of the chats that point at the worktree (archived ones too, a thread or a fork among them), oldest first. */
export function chatsOfWorkspace(db: Database, workspaceId: string): string[] {
    return (db.query('SELECT id FROM chats WHERE workspace_id = ? ORDER BY created_at, id').all(workspaceId) as { id: string }[]).map(row => row.id);
}

export function insertWorkspace(db: Database, record: WorkspaceRecord): void {
    db.query(`
        INSERT INTO workspaces (id, project_id, folder_id, path, branch, base, managed, ready, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.id, record.projectId, record.folderId, record.path, record.branch ?? null, record.base ?? null, record.managed ? 1 : 0, record.ready ? 1 : 0, record.createdAt);
}

/** What a worktree's row may change once it exists: whether it is ready, and its branch (the one the chat was given, once the worktree is known to be on another). */
export type WorkspaceChange = Partial<Pick<WorkspaceRecord, 'ready' | 'branch'>>;

/** Applies the change and returns the row as it is now, or nothing when there is no such worktree. */
export function updateWorkspace(db: Database, id: string, change: WorkspaceChange): WorkspaceRecord | undefined {
    const current = getWorkspace(db, id);

    if (!current) {
        return undefined;
    }

    const next = { ...current, ...change };

    db.query('UPDATE workspaces SET ready = ?, branch = ? WHERE id = ?').run(next.ready ? 1 : 0, next.branch ?? null, id);

    return next;
}

/** Drops the row. The worktree on disk and the chats that point at it are not touched: the caller sees to both. */
export function deleteWorkspace(db: Database, id: string): void {
    db.query('DELETE FROM workspaces WHERE id = ?').run(id);
}

/** Drops every row of a project, for the project's removal (no foreign key does it). */
export function deleteWorkspacesOfProject(db: Database, projectId: string): void {
    db.query('DELETE FROM workspaces WHERE project_id = ?').run(projectId);
}
