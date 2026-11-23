import { clean } from './json';

import type { Database } from 'bun:sqlite';
import type { TaskComment } from '@clowdy/protocol';

interface CommentRow {
    id: string;
    task_id: string;
    author: string;
    body: string;
    created_at: number;
    edited_at: number | null;
}

const toComment = (row: CommentRow): TaskComment =>
    clean({
        id: row.id,
        taskId: row.task_id,
        author: JSON.parse(row.author),
        body: row.body,
        createdAt: row.created_at,
        editedAt: row.edited_at,
    }) as TaskComment;

/** Where a comment stands in the order of a task's comments: the time it was written, and its id, which settles a tie. */
export interface CommentPosition {
    createdAt: number;
    id: string;
}

export function getTaskComment(db: Database, id: string): TaskComment | undefined {
    const row = db.query('SELECT * FROM task_comments WHERE id = ?').get(id) as CommentRow | null;

    return row ? toComment(row) : undefined;
}

export function insertTaskComment(db: Database, comment: TaskComment): void {
    db.query(
        'INSERT INTO task_comments (id, task_id, author, body, created_at, edited_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
        comment.id,
        comment.taskId,
        JSON.stringify(comment.author),
        comment.body,
        comment.createdAt,
        comment.editedAt ?? null
    );
}

export function updateTaskCommentBody(db: Database, id: string, body: string, editedAt: number): void {
    db.query('UPDATE task_comments SET body = ?, edited_at = ? WHERE id = ?').run(body, editedAt, id);
}

export function deleteTaskComment(db: Database, id: string): void {
    db.query('DELETE FROM task_comments WHERE id = ?').run(id);
}

export function countTaskComments(db: Database, taskId: string): number {
    return (db.query('SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ?').get(taskId) as { n: number }).n;
}

/** At most `limit` of the task's comments, oldest first, those after `after` when it is given. */
export function listTaskComments(db: Database, taskId: string, limit: number, after?: CommentPosition): TaskComment[] {
    const rows = after
        ? db
              .query(
                  'SELECT * FROM task_comments WHERE task_id = ? AND (created_at, id) > (?, ?) ORDER BY created_at, id LIMIT ?'
              )
              .all(taskId, after.createdAt, after.id, limit)
        : db.query('SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at, id LIMIT ?').all(taskId, limit);

    return (rows as CommentRow[]).map(toComment);
}

/** The last `count` comments of the task, oldest first. */
export function latestTaskComments(db: Database, taskId: string, count: number): TaskComment[] {
    const rows = db
        .query('SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
        .all(taskId, count) as CommentRow[];

    return rows.reverse().map(toComment);
}
