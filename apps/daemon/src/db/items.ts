import type { StreamItem, StreamItemBody } from '@clowdy/protocol';
import type { Database } from 'bun:sqlite';

interface ItemRow {
    id: string;
    run_id: string;
    seq: number;
    at: number;
    body: string;
}

const toItem = (row: ItemRow): StreamItem => ({
    id: row.id,
    runId: row.run_id,
    seq: row.seq,
    at: row.at,
    body: JSON.parse(row.body) as StreamItemBody,
});

export function listItems(db: Database, runId: string, after: number): StreamItem[] {
    return (db.query('SELECT * FROM stream_items WHERE run_id = ? AND seq > ? ORDER BY seq').all(runId, after) as ItemRow[]).map(toItem);
}

export function getItem(db: Database, runId: string, seq: number): StreamItem | undefined {
    const row = db.query('SELECT * FROM stream_items WHERE run_id = ? AND seq = ?').get(runId, seq) as ItemRow | null;

    return row ? toItem(row) : undefined;
}

/** The first thing the person wrote in a run's stream, which is the message that started a chat's orchestrator. */
export function firstUserItem(db: Database, runId: string): StreamItem | undefined {
    const row = db.query('SELECT * FROM stream_items WHERE run_id = ? AND json_extract(body, \'$.kind\') = \'user\' ORDER BY seq LIMIT 1').get(runId) as ItemRow | null;

    return row ? toItem(row) : undefined;
}

export function findQuestion(db: Database, runId: string, questionId: string): StreamItem | undefined {
    const row = db.query('SELECT * FROM stream_items WHERE run_id = ? AND json_extract(body, \'$.questionId\') = ?').get(runId, questionId) as ItemRow | null;

    return row ? toItem(row) : undefined;
}

/** The tool calls of a run whose item still says they run. */
export function listRunningTools(db: Database, runId: string): StreamItem[] {
    return (db.query('SELECT * FROM stream_items WHERE run_id = ? AND json_extract(body, \'$.kind\') = \'tool\' AND json_extract(body, \'$.state\') = \'running\' ORDER BY seq')
        .all(runId) as ItemRow[]).map(toItem);
}

export function insertItem(db: Database, item: StreamItem): void {
    db.query('INSERT INTO stream_items (id, run_id, seq, at, body) VALUES (?, ?, ?, ?, ?)')
        .run(item.id, item.runId, item.seq, item.at, JSON.stringify(item.body));
}

export function updateItemBody(db: Database, runId: string, seq: number, body: StreamItemBody): void {
    db.query('UPDATE stream_items SET body = ? WHERE run_id = ? AND seq = ?').run(JSON.stringify(body), runId, seq);
}

export function nextSeq(db: Database, runId: string): number {
    return (db.query('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM stream_items WHERE run_id = ?').get(runId) as { seq: number }).seq;
}

/** The number of the last `user` item of a run's stream, the message its latest turn answers; 0 when it has none. */
export function lastUserSeq(db: Database, runId: string): number {
    return (db.query('SELECT COALESCE(MAX(seq), 0) AS seq FROM stream_items WHERE run_id = ? AND json_extract(body, \'$.kind\') = \'user\'').get(runId) as { seq: number }).seq;
}
