import { clean, parseJson, toJson } from './json';
import { deleteRuns } from './runs';

import type { Chat, ChatTaskLink, QueuedMessage, Run } from '@clowdy/protocol';
import type { Database } from 'bun:sqlite';

interface ChatRow {
    id: string;
    project_id: string;
    title: string;
    mode: Chat['mode'];
    engine: string | null;
    model: string | null;
    effort: string | null;
    orchestrator_run_id: string | null;
    parent_chat_id: string | null;
    folder_id: string | null;
    source_chat_id: string | null;
    forked_at_seq: number | null;
    archived_at: number | null;
    queue: string | null;
    queue_paused: Chat['queuePaused'] | null;
    created_at: number;
    updated_at: number;
}

const toChat = (row: ChatRow): Chat => clean({
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    mode: row.mode,
    engine: row.engine,
    model: row.model,
    effort: row.effort,
    orchestratorRunId: row.orchestrator_run_id,
    parentChatId: row.parent_chat_id,
    folderId: row.folder_id,
    forkedFrom: row.source_chat_id !== null && row.forked_at_seq !== null ? { chatId: row.source_chat_id, atSeq: row.forked_at_seq } : null,
    archivedAt: row.archived_at,
    queue: parseJson<QueuedMessage[]>(row.queue),
    queuePaused: row.queue_paused,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
}) as Chat;

export function getChat(db: Database, id: string): Chat | undefined {
    const row = db.query('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | null;

    return row ? toChat(row) : undefined;
}

export function listChats(db: Database, projectId: string): Chat[] {
    return (db.query('SELECT * FROM chats WHERE project_id = ? ORDER BY created_at, id').all(projectId) as ChatRow[]).map(toChat);
}

/**
 * A chat's parent, folder and the fork it comes from are set when the chat is made and never change, so an update leaves them alone: a stale copy of a chat
 * cannot bring back a folder `clearChatFolders` took away (`setForkPoint` moves where a fork's history ends).
 */
export function upsertChat(db: Database, chat: Chat): void {
    db.query(`
        INSERT INTO chats (id, project_id, title, mode, engine, model, effort, orchestrator_run_id, parent_chat_id, folder_id, source_chat_id, forked_at_seq, archived_at, queue, queue_paused,
            created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, mode = excluded.mode, engine = excluded.engine, model = excluded.model, effort = excluded.effort,
            orchestrator_run_id = excluded.orchestrator_run_id, archived_at = excluded.archived_at, queue = excluded.queue, queue_paused = excluded.queue_paused,
            updated_at = excluded.updated_at
    `).run(
        chat.id, chat.projectId, chat.title, chat.mode, chat.engine ?? null, chat.model ?? null, chat.effort ?? null, chat.orchestratorRunId ?? null,
        chat.parentChatId ?? null, chat.folderId ?? null, chat.forkedFrom?.chatId ?? null, chat.forkedFrom?.atSeq ?? null, chat.archivedAt ?? null,
        chat.queue?.length ? toJson(chat.queue) : null, chat.queuePaused ?? null, chat.createdAt, chat.updatedAt
    );
}

/** Moves where a fork's inherited history ends (`forkedFrom.atSeq`), for an edit that cut into it: an update leaves the relation alone, so this is its one writer. */
export function setForkPoint(db: Database, chatId: string, atSeq: number): void {
    db.query('UPDATE chats SET forked_at_seq = ? WHERE id = ? AND source_chat_id IS NOT NULL').run(atSeq, chatId);
}

/** Takes the folder off every chat of the project that chose one outside `folderIds` (a folder the project no longer has), and returns those chats as they are now. */
export function clearChatFolders(db: Database, projectId: string, folderIds: readonly string[]): Chat[] {
    const rows = db.query(`
        UPDATE chats SET folder_id = NULL
        WHERE project_id = ? AND folder_id IS NOT NULL AND folder_id NOT IN (SELECT value FROM json_each(?))
        RETURNING *
    `).all(projectId, JSON.stringify(folderIds)) as ChatRow[];

    return rows.map(toChat);
}

/** How many chats work in each folder by choice, by folder id (an id belongs to one project); a folder none chose is not there. */
export function chatCountsByFolder(db: Database): Map<string, number> {
    const rows = db.query('SELECT folder_id AS folderId, COUNT(*) AS chats FROM chats WHERE folder_id IS NOT NULL GROUP BY folder_id').all() as { folderId: string; chats: number }[];

    return new Map(rows.map(row => [row.folderId, row.chats]));
}

/** The threads a chat started, oldest first: its direct children, not theirs. */
export function listChildChats(db: Database, chatId: string): Chat[] {
    return (db.query('SELECT * FROM chats WHERE parent_chat_id = ? ORDER BY created_at, id').all(chatId) as ChatRow[]).map(toChat);
}

/**
 * Every chat below `chatId`, threads of threads included, each with its depth below it (1 is a thread of that chat, 2 a thread of one of those).
 * Shallower chats come first, so a parent always comes before its threads.
 */
export function listChatDescendants(db: Database, chatId: string): { chat: Chat; depth: number }[] {
    const rows = db.query(`
        WITH RECURSIVE tree(id, depth) AS (
            SELECT id, 1 FROM chats WHERE parent_chat_id = ?
            UNION ALL
            SELECT c.id, tree.depth + 1 FROM chats c JOIN tree ON c.parent_chat_id = tree.id
        )
        SELECT chats.*, tree.depth AS tree_depth FROM tree JOIN chats ON chats.id = tree.id ORDER BY tree.depth, chats.created_at, chats.id
    `).all(chatId) as (ChatRow & { tree_depth: number })[];

    return rows.map(({ tree_depth: depth, ...row }) => ({ chat: toChat(row), depth }));
}

export function listChatTaskLinks(db: Database, projectId: string): ChatTaskLink[] {
    return db.query(`
        SELECT l.chat_id AS chatId, l.task_id AS taskId FROM chat_task_links l JOIN chats c ON c.id = l.chat_id
        WHERE c.project_id = ? ORDER BY l.rowid
    `).all(projectId) as ChatTaskLink[];
}

export function chatIdsOfTask(db: Database, taskId: string): string[] {
    return (db.query('SELECT chat_id FROM chat_task_links WHERE task_id = ? ORDER BY rowid').all(taskId) as { chat_id: string }[]).map(row => row.chat_id);
}

/** Returns false when the link already existed. */
export function insertChatTaskLink(db: Database, link: ChatTaskLink): boolean {
    return db.query('INSERT OR IGNORE INTO chat_task_links (chat_id, task_id) VALUES (?, ?)').run(link.chatId, link.taskId).changes > 0;
}

/** The chat's runs: its orchestrator and everything below it. A thread's runs are its own chat's, not its parent's. */
export function runsOfChat(db: Database, chatId: string): { id: string; status: Run['status'] }[] {
    return db.query(`
        SELECT id, status FROM runs
        WHERE chat_id = ?1 OR root_run_id IN (SELECT id FROM runs WHERE chat_id = ?1)
        ORDER BY created_at, id
    `).all(chatId) as { id: string; status: Run['status'] }[];
}

/**
 * Deletes the chat and its runs, its sub-agents' runs too. Streams and run-task links go with the runs, and chat-task links with the chat.
 * The runs go in one statement, which SQLite checks at its end, so parents and children may go together. The chat's threads are not touched.
 */
export function deleteChatAndRuns(db: Database, chatId: string): void {
    deleteRuns(db, runsOfChat(db, chatId).map(run => run.id));
    db.query('DELETE FROM chats WHERE id = ?').run(chatId);
}

/** Chats whose queue holds messages, for the start of the daemon: an orchestrator that came to rest just before a crash still owes them a turn. */
export function chatIdsWithQueue(db: Database): string[] {
    return (db.query('SELECT id FROM chats WHERE queue IS NOT NULL ORDER BY updated_at, id').all() as { id: string }[]).map(row => row.id);
}
