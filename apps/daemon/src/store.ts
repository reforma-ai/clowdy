import type { Database } from 'bun:sqlite';
import type { ClowdyEvent, CommandResult, EngineId, EventData } from '@clowdy/protocol';

export type EventListener = (events: ClowdyEvent[]) => void;

interface EventRow {
    cursor: number;
    at: number;
    project_id: string;
    data: string;
}

const toEvent = (row: EventRow): ClowdyEvent => ({
    cursor: row.cursor,
    at: row.at,
    projectId: row.project_id,
    data: JSON.parse(row.data) as EventData,
});

/**
 * The write path. Every mutation runs in `tx`, and every state change inserts its event row in that same
 * transaction through `emit`, so the log and the state cannot disagree. Work that must not happen when the
 * transaction rolls back (starting a run, waking subscribers) goes through `afterCommit`.
 *
 * Everything is synchronous: never await inside a transaction.
 */
export class Store {
    private depth = 0;
    private pending: ClowdyEvent[] = [];
    private callbacks: (() => void)[] = [];
    private listeners = new Set<EventListener>();

    /**
     * Whether the engine `id` can fork its sessions at rewind points (`AgentEngine.canFork`). The daemon sets it once its engines exist; until then, and in a
     * store nobody wired, no engine can. A stream item says `canFork` and `canEdit` by it, read each time an item is listed or published and never stored,
     * so an agent whose flag is switched off stops offering both for the chats it already has.
     */
    forkable: (engine: EngineId) => boolean = () => false;

    constructor(readonly db: Database) {}

    /** Runs `fn` in a transaction. Nested calls join the outer transaction; an exception rolls everything back. */
    tx<T>(fn: () => T): T {
        if (this.depth > 0) {
            return fn();
        }

        this.depth = 1;

        let result: T;

        try {
            result = this.db.transaction(fn).immediate();
        } catch (error) {
            this.pending = [];
            this.callbacks = [];
            throw error;
        } finally {
            this.depth = 0;
        }

        const { pending, callbacks } = this;

        this.pending = [];
        this.callbacks = [];

        for (const callback of callbacks) {
            guarded(callback);
        }

        if (pending.length > 0) {
            for (const listener of this.listeners) {
                guarded(() => listener(pending));
            }
        }

        return result;
    }

    /** Runs `fn` against one consistent view of the database. */
    read<T>(fn: () => T): T {
        return this.depth > 0 ? fn() : this.db.transaction(fn).deferred();
    }

    /** Appends an event to the log. Must be called inside `tx`. */
    emit(projectId: string, data: EventData): ClowdyEvent {
        if (this.depth === 0) {
            throw new Error('emit() called outside a transaction');
        }

        const at = Date.now();
        const row = this.db
            .query('INSERT INTO events (at, project_id, type, data) VALUES (?, ?, ?, ?) RETURNING cursor')
            .get(at, projectId, data.type, JSON.stringify(data)) as { cursor: number };
        const event: ClowdyEvent = { cursor: row.cursor, at, projectId, data };

        this.pending.push(event);

        return event;
    }

    /** Runs `fn` once the outermost transaction commits; right away outside a transaction. Dropped on rollback. */
    afterCommit(fn: () => void): void {
        if (this.depth === 0) {
            guarded(fn);
        } else {
            this.callbacks.push(fn);
        }
    }

    /** Calls `listener` with the events of every committed transaction. Returns the unsubscribe function. */
    subscribe(listener: EventListener): () => void {
        this.listeners.add(listener);

        return () => this.listeners.delete(listener);
    }

    /** The cursor of the newest event; 0 for an empty log. */
    headCursor(): number {
        return (this.db.query('SELECT COALESCE(MAX(cursor), 0) AS cursor FROM events').get() as { cursor: number })
            .cursor;
    }

    eventsAfter(cursor: number, projectId: string | undefined, limit: number): ClowdyEvent[] {
        const rows =
            projectId === undefined
                ? this.db.query('SELECT * FROM events WHERE cursor > ? ORDER BY cursor LIMIT ?').all(cursor, limit)
                : this.db
                      .query('SELECT * FROM events WHERE cursor > ? AND project_id = ? ORDER BY cursor LIMIT ?')
                      .all(cursor, projectId, limit);

        return (rows as EventRow[]).map(toEvent);
    }

    commandResult(requestId: string): CommandResult | undefined {
        const row = this.db.query('SELECT result FROM commands WHERE request_id = ?').get(requestId) as {
            result: string;
        } | null;

        return row ? (JSON.parse(row.result) as CommandResult) : undefined;
    }

    saveCommandResult(result: CommandResult): void {
        this.db
            .query('INSERT INTO commands (request_id, result, at) VALUES (?, ?, ?)')
            .run(result.requestId, JSON.stringify(result), Date.now());
    }
}

function guarded(fn: () => void): void {
    try {
        fn();
    } catch (error) {
        console.error('[clowdy] a post-commit callback failed:', error);
    }
}
