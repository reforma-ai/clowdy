import {
    countTaskComments,
    deleteTaskComment as deleteTaskCommentRow,
    getTaskComment,
    insertTaskComment,
    listTaskComments,
    updateTaskCommentBody,
} from '../db/taskComments';
import { invalid, notFound } from '../errors';
import { newId } from '../ids';
import { DEFAULT_LIMIT, MAX_LIMIT } from './taskQuery';
import { requireTask } from './tasks';

import type { Actor, TaskComment } from '@clowdy/protocol';
import type { CommentPosition } from '../db/taskComments';
import type { Store } from '../store';

/** A body keeps its Markdown as written, less the whitespace at its end (a heredoc's line break); one with nothing in it is no comment. */
function cleanBody(body: string): string {
    const trimmed = body.trimEnd();

    if (trimmed === '') {
        throw invalid('A comment cannot be empty');
    }

    return trimmed;
}

/** The comment `commentId` of the task; a comment of another task is as good as none. */
function requireComment(store: Store, taskId: string, commentId: string): TaskComment {
    const comment = getTaskComment(store.db, commentId);

    if (!comment || comment.taskId !== taskId) {
        throw notFound('Comment', commentId);
    }

    return comment;
}

export interface NewTaskComment {
    taskId: string;
    /** The person for a command of the app, the run for a comment an agent leaves. */
    author: Actor;
    body: string;
}

export function addTaskComment(store: Store, input: NewTaskComment): TaskComment {
    return store.tx(() => {
        const task = requireTask(store, input.taskId);
        const comment: TaskComment = { id: newId('cmt'), taskId: task.id, author: input.author, body: cleanBody(input.body), createdAt: Date.now() };

        insertTaskComment(store.db, comment);
        store.emit(task.projectId, { type: 'task.comment.upserted', comment });

        return comment;
    });
}

/** Replaces the body and stamps `editedAt`; the same body is no edit, so it neither stamps nor announces anything. */
export function editTaskComment(store: Store, taskId: string, commentId: string, body: string): TaskComment {
    return store.tx(() => {
        const task = requireTask(store, taskId);
        const comment = requireComment(store, task.id, commentId);
        const next = cleanBody(body);

        if (next === comment.body) {
            return comment;
        }

        const edited: TaskComment = { ...comment, body: next, editedAt: Date.now() };

        updateTaskCommentBody(store.db, comment.id, edited.body, edited.editedAt as number);
        store.emit(task.projectId, { type: 'task.comment.upserted', comment: edited });

        return edited;
    });
}

export function deleteTaskComment(store: Store, taskId: string, commentId: string): void {
    store.tx(() => {
        const task = requireTask(store, taskId);
        const comment = requireComment(store, task.id, commentId);

        deleteTaskCommentRow(store.db, comment.id);
        store.emit(task.projectId, { type: 'task.comment.deleted', taskId: task.id, commentId: comment.id });
    });
}

/** A cursor names the last comment of a page by its place in the order, so comments added or deleted between pages neither repeat nor shift the rest. */
const encodeCursor = (comment: TaskComment) => `${ comment.createdAt }.${ comment.id }`;

function decodeCursor(cursor: string): CommentPosition {
    const match = /^(\d+)\.(cmt_[0-9A-Z]+)$/.exec(cursor);

    if (!match) {
        throw invalid(`"${ cursor }" is not a cursor: pass the nextCursor of the previous page unchanged`);
    }

    return { createdAt: Number(match[1]), id: match[2] };
}

export interface CommentsQuery {
    /** How many comments, 1 to `MAX_LIMIT`; `DEFAULT_LIMIT` when absent. */
    limit?: number;
    /** The `nextCursor` of the previous page. */
    cursor?: string;
}

export interface CommentsPage {
    comments: TaskComment[];
    /** How many comments the task has, whatever the page holds. */
    total: number;
    shown: number;
    nextCursor?: string;
}

/** One page of the task's comments, oldest first, read in one transaction so `total` and the page agree. */
export function taskCommentsPage(store: Store, taskId: string, query: CommentsQuery = {}): CommentsPage {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);

    return store.read(() => {
        const task = requireTask(store, taskId);
        // One more than the page holds says whether another page follows without a second query.
        const found = listTaskComments(store.db, task.id, limit + 1, after);
        const comments = found.slice(0, limit);
        const last = comments.at(-1);

        return {
            comments,
            total: countTaskComments(store.db, task.id),
            shown: comments.length,
            ...(last && found.length > limit && { nextCursor: encodeCursor(last) }),
        };
    });
}
