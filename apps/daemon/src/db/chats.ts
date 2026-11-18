import { clean } from './json';

import type { Chat, ChatTaskLink, Run } from '@clowdy/protocol';
import type { Database } from 'bun:sqlite';

interface ChatRow {
    id: string;
    project_id: string;
    title: string;
    mode: Chat['mode'];
    orchestrator_run_id: string | null;
    archived_at: number | null;
    created_at: number;
    updated_at: number;
}

const toChat = (row: ChatRow): Chat => clean({
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    mode: row.mode,
    orchestratorRunId: row.orchestrator_run_id,
    archivedAt: row.archived_at,
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

export function upsertChat(db: Database, chat: Chat): void {
    db.query(`
        INSERT INTO chats (id, project_id, title, mode, orchestrator_run_id, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, mode = excluded.mode,
            orchestrator_run_id = excluded.orchestrator_run_id, archived_at = excluded.archived_at, updated_at = excluded.updated_at
    `).run(chat.id, chat.projectId, chat.title, chat.mode, chat.orchestratorRunId ?? null, chat.archivedAt ?? null, chat.createdAt, chat.updatedAt);
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

/** The chat's runs: its orchestrator and everything below it. */
export function runsOfChat(db: Database, chatId: string): { id: string; status: Run['status'] }[] {
    return db.query(`
        SELECT id, status FROM runs
        WHERE chat_id = ?1 OR root_run_id IN (SELECT id FROM runs WHERE chat_id = ?1)
        ORDER BY created_at, id
    `).all(chatId) as { id: string; status: Run['status'] }[];
}

/**
 * Deletes the chat and its runs. Streams, run-task links and mailbox rows go with the runs, and chat-task links with the chat.
 * The runs go in one statement, which SQLite checks at its end, so parents and children may go together.
 */
export function deleteChatAndRuns(db: Database, chatId: string): void {
    db.query('DELETE FROM runs WHERE chat_id = ?1 OR root_run_id IN (SELECT id FROM runs WHERE chat_id = ?1)').run(chatId);
    db.query('DELETE FROM chats WHERE id = ?').run(chatId);
}
