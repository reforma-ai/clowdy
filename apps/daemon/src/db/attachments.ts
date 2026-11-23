import { clean } from './json';

import type { Database } from 'bun:sqlite';
import type { Attachment } from '@clowdy/protocol';

/** What the daemon knows about an uploaded file: the part clients see, and where it belongs. */
export interface AttachmentRecord extends Attachment {
    projectId: string;
    /** The chat and its orchestrator run the file was sent with; absent until then. */
    chatId?: string;
    runId?: string;
    createdAt: number;
}

interface AttachmentRow {
    id: string;
    project_id: string;
    name: string;
    media_type: string;
    size: number;
    chat_id: string | null;
    run_id: string | null;
    created_at: number;
}

const toRecord = (row: AttachmentRow): AttachmentRecord =>
    clean({
        id: row.id,
        name: row.name,
        mediaType: row.media_type,
        size: row.size,
        projectId: row.project_id,
        chatId: row.chat_id,
        runId: row.run_id,
        createdAt: row.created_at,
    }) as AttachmentRecord;

export function getAttachment(db: Database, id: string): AttachmentRecord | undefined {
    const row = db.query('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRow | null;

    return row ? toRecord(row) : undefined;
}

export function insertAttachment(db: Database, record: AttachmentRecord): void {
    db.query(
        'INSERT INTO attachments (id, project_id, name, media_type, size, chat_id, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
        record.id,
        record.projectId,
        record.name,
        record.mediaType,
        record.size,
        record.chatId ?? null,
        record.runId ?? null,
        record.createdAt
    );
}

/** Marks unsent files as sent with this chat and run. Returns how many it changed. */
export function markAttachmentsSent(db: Database, ids: string[], chatId: string, runId: string): number {
    const update = db.query('UPDATE attachments SET chat_id = ?, run_id = ? WHERE id = ? AND chat_id IS NULL');

    return ids.reduce((changed, id) => changed + update.run(chatId, runId, id).changes, 0);
}

/** Makes sent files unsent again, as if they had just been uploaded: a message box may send them with another message. Returns how many it changed. */
export function markAttachmentsUnsent(db: Database, ids: string[], now: number): number {
    const update = db.query('UPDATE attachments SET chat_id = NULL, run_id = NULL, created_at = ? WHERE id = ?');

    return ids.reduce((changed, id) => changed + update.run(now, id).changes, 0);
}

export function deleteAttachment(db: Database, id: string): void {
    db.query('DELETE FROM attachments WHERE id = ?').run(id);
}

/** Removes the rows of the files sent in a chat and returns their ids. */
export function deleteAttachmentsOfChat(db: Database, chatId: string): string[] {
    const ids = (db.query('SELECT id FROM attachments WHERE chat_id = ?').all(chatId) as { id: string }[]).map(
        row => row.id
    );

    db.query('DELETE FROM attachments WHERE chat_id = ?').run(chatId);

    return ids;
}

/** Removes the rows of every file of a project and returns their ids. */
export function deleteAttachmentsOfProject(db: Database, projectId: string): string[] {
    const ids = (db.query('SELECT id FROM attachments WHERE project_id = ?').all(projectId) as { id: string }[]).map(
        row => row.id
    );

    db.query('DELETE FROM attachments WHERE project_id = ?').run(projectId);

    return ids;
}

/** Files uploaded before `before` (epoch ms) that no message claimed. */
export function unsentAttachmentIdsBefore(db: Database, before: number): string[] {
    return (
        db.query('SELECT id FROM attachments WHERE chat_id IS NULL AND created_at < ?').all(before) as { id: string }[]
    ).map(row => row.id);
}

export function allAttachmentIds(db: Database): Set<string> {
    return new Set((db.query('SELECT id FROM attachments').all() as { id: string }[]).map(row => row.id));
}
