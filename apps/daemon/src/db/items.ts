import type { StreamItem, StreamItemBody } from '@clowdy/protocol';
import type { Database } from 'bun:sqlite';

interface ItemRow {
    id: string;
    run_id: string;
    seq: number;
    at: number;
    body: string;
    /** 1 when the item holds a rewind point; only the flagged query reads it. */
    point?: number;
    /** 1 when the item is a message of the person's own that starts a turn; only the flagged query reads it. */
    opens?: number;
}

/**
 * The columns of an item, and what its flags are made of: whether it holds a rewind point (`provider_ref`), and whether it is a message of the person's own
 * (a `user` item without `from`) that starts a turn, which is the first item of the stream, or the first one after an item that holds a point. Notes and
 * the agent's reasoning are not part of a turn's story, so the item before is the last one that is neither. The subquery runs for `user` items only.
 */
const FLAGGED = `
    SELECT s.id, s.run_id, s.seq, s.at, s.body, s.provider_ref IS NOT NULL AS point,
        CASE WHEN json_extract(s.body, '$.kind') = 'user' AND json_extract(s.body, '$.from') IS NULL THEN COALESCE((
            SELECT p.provider_ref IS NOT NULL FROM stream_items p
            WHERE p.run_id = s.run_id AND p.seq < s.seq AND json_extract(p.body, '$.kind') NOT IN ('note', 'reasoning')
            ORDER BY p.seq DESC LIMIT 1
        ), 1) ELSE 0 END AS opens
    FROM stream_items s`;

/**
 * `flagged`: the engine of the item's run can fork at rewind points, so the item says what the app may offer on it (`canFork`, `canEdit`). Off, an item is
 * its stored self, which is what everything that only reads the words wants.
 */
const toItem = (row: ItemRow, flagged: boolean): StreamItem => {
    const body = JSON.parse(row.body) as StreamItemBody;

    return {
        id: row.id,
        runId: row.run_id,
        seq: row.seq,
        at: row.at,
        body,
        ...(flagged && row.point === 1 && body.kind === 'assistant' && { canFork: true }),
        ...(flagged && row.opens === 1 && { canEdit: true }),
    };
};

export function listItems(db: Database, runId: string, after: number, flagged = false): StreamItem[] {
    return (db.query(`${ flagged ? FLAGGED : 'SELECT * FROM stream_items s' } WHERE s.run_id = ? AND s.seq > ? ORDER BY s.seq`).all(runId, after) as ItemRow[]).map(row => toItem(row, flagged));
}

export function getItem(db: Database, runId: string, seq: number, flagged = false): StreamItem | undefined {
    const row = db.query(`${ flagged ? FLAGGED : 'SELECT * FROM stream_items s' } WHERE s.run_id = ? AND s.seq = ?`).get(runId, seq) as ItemRow | null;

    return row ? toItem(row, flagged) : undefined;
}

/** The first thing the person wrote in a run's stream, which is the message that started a chat's orchestrator. */
export function firstUserItem(db: Database, runId: string): StreamItem | undefined {
    const row = db.query('SELECT * FROM stream_items WHERE run_id = ? AND json_extract(body, \'$.kind\') = \'user\' ORDER BY seq LIMIT 1').get(runId) as ItemRow | null;

    return row ? toItem(row, false) : undefined;
}

export function findQuestion(db: Database, runId: string, questionId: string): StreamItem | undefined {
    const row = db.query('SELECT * FROM stream_items WHERE run_id = ? AND json_extract(body, \'$.questionId\') = ?').get(runId, questionId) as ItemRow | null;

    return row ? toItem(row, false) : undefined;
}

export function findApproval(db: Database, runId: string, approvalId: string): StreamItem | undefined {
    const row = db.query('SELECT * FROM stream_items WHERE run_id = ? AND json_extract(body, \'$.approvalId\') = ?').get(runId, approvalId) as ItemRow | null;

    return row ? toItem(row, false) : undefined;
}

/** The approvals of a run whose item still says they wait for the person, which only a crash or a restart leaves behind. */
export function listOpenApprovals(db: Database, runId: string): StreamItem[] {
    return (db.query('SELECT * FROM stream_items WHERE run_id = ? AND json_extract(body, \'$.kind\') = \'approval\' AND json_extract(body, \'$.state\') = \'open\' ORDER BY seq')
        .all(runId) as ItemRow[]).map(row => toItem(row, false));
}

/** The tool calls of a run whose item still says they run. */
export function listRunningTools(db: Database, runId: string): StreamItem[] {
    return (db.query('SELECT * FROM stream_items WHERE run_id = ? AND json_extract(body, \'$.kind\') = \'tool\' AND json_extract(body, \'$.state\') = \'running\' ORDER BY seq')
        .all(runId) as ItemRow[]).map(row => toItem(row, false));
}

/** The thoughts of a run's stream that are still open (`done: false`), which only a crash leaves behind. */
export function listOpenThoughts(db: Database, runId: string): StreamItem[] {
    return (db.query('SELECT * FROM stream_items WHERE run_id = ? AND json_extract(body, \'$.kind\') = \'reasoning\' AND json_extract(body, \'$.done\') = 0 ORDER BY seq')
        .all(runId) as ItemRow[]).map(row => toItem(row, false));
}

/** `ref` is the item's rewind point, for a copy of an item that holds one (`copyItems`); every other item gets its point later, if it is the end of a turn. */
export function insertItem(db: Database, item: StreamItem, ref?: string): void {
    db.query('INSERT INTO stream_items (id, run_id, seq, at, body, provider_ref) VALUES (?, ?, ?, ?, ?, ?)')
        .run(item.id, item.runId, item.seq, item.at, JSON.stringify(item.body), ref ?? null);
}

/** The number of an item of a run's stream by its id; `undefined` when the run has no such item. */
export function itemSeqOf(db: Database, runId: string, itemId: string): number | undefined {
    const row = db.query('SELECT seq FROM stream_items WHERE run_id = ? AND id = ?').get(runId, itemId) as { seq: number } | null;

    return row?.seq;
}

/** The items of a run's stream from the first through `seq`, as they are stored, each with its rewind point when it holds one. */
export function listItemsWithRefs(db: Database, runId: string, throughSeq: number): { item: StreamItem; ref?: string }[] {
    const rows = db.query('SELECT *, provider_ref AS ref FROM stream_items s WHERE s.run_id = ? AND s.seq <= ? ORDER BY s.seq').all(runId, throughSeq) as (ItemRow & { ref: string | null })[];

    return rows.map(row => ({ item: toItem(row, false), ...(row.ref !== null && { ref: row.ref }) }));
}

/**
 * The item a turn that starts at `seq` follows: the last item before it that is neither a note nor the agent's reasoning, with the rewind point it holds (`null` for one that holds none);
 * `undefined` when nothing comes before it, which makes it the first message of the chat.
 */
export function itemBefore(db: Database, runId: string, seq: number): { ref: string | null } | undefined {
    const row = db.query('SELECT provider_ref AS ref FROM stream_items WHERE run_id = ? AND seq < ? AND json_extract(body, \'$.kind\') NOT IN (\'note\', \'reasoning\') ORDER BY seq DESC LIMIT 1').get(runId, seq) as { ref: string | null } | null;

    return row ?? undefined;
}

/** Removes the items of a run's stream from `seq` on. */
export function deleteItemsFrom(db: Database, runId: string, seq: number): void {
    db.query('DELETE FROM stream_items WHERE run_id = ? AND seq >= ?').run(runId, seq);
}

/** The rewind point an item holds: the agent's own id of the message it says, or `undefined` for an item that holds none. */
export function itemRef(db: Database, runId: string, seq: number): string | undefined {
    const row = db.query('SELECT provider_ref AS ref FROM stream_items WHERE run_id = ? AND seq = ?').get(runId, seq) as { ref: string | null } | null;

    return row?.ref ?? undefined;
}

export function setItemRef(db: Database, runId: string, seq: number, ref: string): void {
    db.query('UPDATE stream_items SET provider_ref = ? WHERE run_id = ? AND seq = ?').run(ref, runId, seq);
}

/** The number of the last item of a run's stream that is neither a note nor the agent's reasoning, which is where its story stands; 0 when there is none. */
export function lastStorySeq(db: Database, runId: string): number {
    return (db.query('SELECT COALESCE(MAX(seq), 0) AS seq FROM stream_items WHERE run_id = ? AND json_extract(body, \'$.kind\') NOT IN (\'note\', \'reasoning\')').get(runId) as { seq: number }).seq;
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
