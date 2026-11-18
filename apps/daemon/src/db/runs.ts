import { ACTIVE_RUN_STATUSES } from '@clowdy/protocol';

import { clean, parseJson, toJson } from './json';

import type { Run, RunOrigin, RunRole, RunTaskLink, RunUsage } from '@clowdy/protocol';
import type { Database } from 'bun:sqlite';

interface RunRow {
    id: string;
    project_id: string;
    parent_run_id: string | null;
    root_run_id: string;
    chat_id: string | null;
    role: RunRole;
    origin: RunOrigin | null;
    name: string;
    summary: string;
    status: Run['status'];
    status_reason: string | null;
    engine: Run['engine'];
    model: string | null;
    effort: string | null;
    session_id: string | null;
    worktree: string | null;
    result: string | null;
    error: string | null;
    usage: string | null;
    created_at: number;
    started_at: number | null;
    finished_at: number | null;
}

const toRun = (row: RunRow): Run => clean({
    id: row.id,
    projectId: row.project_id,
    parentRunId: row.parent_run_id,
    rootRunId: row.root_run_id,
    chatId: row.chat_id,
    role: row.role,
    origin: row.origin,
    name: row.name,
    summary: row.summary,
    status: row.status,
    statusReason: row.status_reason,
    engine: row.engine,
    model: row.model,
    effort: row.effort,
    sessionId: row.session_id,
    worktree: parseJson(row.worktree),
    result: row.result,
    error: row.error,
    usage: parseJson<RunUsage>(row.usage),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
}) as Run;

const ACTIVE = ACTIVE_RUN_STATUSES.map(status => `'${ status }'`).join(', ');

export function getRun(db: Database, id: string): Run | undefined {
    const row = db.query('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | null;

    return row ? toRun(row) : undefined;
}

export function listRuns(db: Database, projectId: string): Run[] {
    return (db.query('SELECT * FROM runs WHERE project_id = ? ORDER BY created_at, id').all(projectId) as RunRow[]).map(toRun);
}

export function upsertRun(db: Database, run: Run): void {
    db.query(`
        INSERT INTO runs (id, project_id, parent_run_id, root_run_id, chat_id, role, origin, name, summary, status, status_reason, engine, model, effort,
            session_id, worktree, result, error, usage, created_at, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, status = excluded.status, status_reason = excluded.status_reason,
            model = excluded.model, effort = excluded.effort, session_id = excluded.session_id, worktree = excluded.worktree, result = excluded.result,
            error = excluded.error, usage = excluded.usage, started_at = excluded.started_at, finished_at = excluded.finished_at
    `).run(
        run.id, run.projectId, run.parentRunId ?? null, run.rootRunId, run.chatId ?? null, run.role, run.origin ?? null, run.name, run.summary, run.status,
        run.statusReason ?? null, run.engine, run.model ?? null, run.effort ?? null, run.sessionId ?? null, toJson(run.worktree), run.result ?? null,
        run.error ?? null, toJson(run.usage), run.createdAt, run.startedAt ?? null, run.finishedAt ?? null
    );
}

export function listActiveRuns(db: Database): Run[] {
    return (db.query(`SELECT * FROM runs WHERE status IN (${ ACTIVE }) ORDER BY created_at, id`).all() as RunRow[]).map(toRun);
}

/** The run and its descendants that are still active, deepest first, so children come before their parents. */
export function activeSubtree(db: Database, runId: string): string[] {
    const rows = db.query(`
        WITH RECURSIVE tree(id, depth) AS (
            SELECT id, 0 FROM runs WHERE id = ?
            UNION ALL
            SELECT r.id, tree.depth + 1 FROM runs r JOIN tree ON r.parent_run_id = tree.id
        )
        SELECT runs.id FROM tree JOIN runs ON runs.id = tree.id WHERE runs.status IN (${ ACTIVE }) ORDER BY tree.depth DESC, runs.created_at DESC
    `).all(runId) as { id: string }[];

    return rows.map(row => row.id);
}

export function isDescendant(db: Database, ancestorId: string, runId: string): boolean {
    const row = db.query(`
        WITH RECURSIVE up(id) AS (
            SELECT parent_run_id FROM runs WHERE id = ?
            UNION ALL
            SELECT r.parent_run_id FROM runs r JOIN up ON r.id = up.id
        )
        SELECT 1 AS found FROM up WHERE id = ? LIMIT 1
    `).get(runId, ancestorId);

    return row !== null;
}

/** Runs holding a slot, by engine and project. Sub-agents inside a session (`native`) never hold one. */
export function runningCounts(db: Database): { engine: string; projectId: string; count: number }[] {
    return db.query(`
        SELECT engine, project_id AS projectId, COUNT(*) AS count FROM runs
        WHERE status = 'running' AND origin IS NOT 'native' GROUP BY engine, project_id
    `).all() as { engine: string; projectId: string; count: number }[];
}

/** Runs a client would call work in progress; sub-agents inside a session do not count. */
export function countActiveRuns(db: Database): number {
    return (db.query(`SELECT COUNT(*) AS n FROM runs WHERE status IN (${ ACTIVE }) AND origin IS NOT 'native'`).get() as { n: number }).n;
}

export function countRunsWithRole(db: Database, projectId: string, role: RunRole): number {
    return (db.query('SELECT COUNT(*) AS n FROM runs WHERE project_id = ? AND role = ? AND origin IS NOT \'native\'').get(projectId, role) as { n: number }).n;
}

/** Runs another run started with `run_spawn`. */
export function countSpawnedChildren(db: Database, runId: string): number {
    return (db.query('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = ? AND origin = \'spawned\'').get(runId) as { n: number }).n;
}

export function countActiveSpawnedChildren(db: Database, runId: string): number {
    return (db.query(`SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = ? AND origin = 'spawned' AND status IN (${ ACTIVE })`).get(runId) as { n: number }).n;
}

export function findSpawnedChild(db: Database, parentRunId: string, idempotencyKey: string): Run | undefined {
    const row = db.query('SELECT * FROM runs WHERE parent_run_id = ? AND idempotency_key = ?').get(parentRunId, idempotencyKey) as RunRow | null;

    return row ? toRun(row) : undefined;
}

/** How many runs sit above this one: 0 for a root. */
export function depthOf(db: Database, runId: string): number {
    const row = db.query(`
        WITH RECURSIVE up(id) AS (
            SELECT parent_run_id FROM runs WHERE id = ?
            UNION ALL
            SELECT r.parent_run_id FROM runs r JOIN up ON r.id = up.id
        )
        SELECT COUNT(*) AS n FROM up WHERE id IS NOT NULL
    `).get(runId) as { n: number };

    return row.n;
}

export function listRunTaskLinks(db: Database, projectId: string): RunTaskLink[] {
    return db.query(`
        SELECT l.run_id AS runId, l.task_id AS taskId, l.relation FROM run_task_links l JOIN runs r ON r.id = l.run_id
        WHERE r.project_id = ? ORDER BY l.rowid
    `).all(projectId) as RunTaskLink[];
}

export function linksOfRun(db: Database, runId: string): RunTaskLink[] {
    return db.query('SELECT run_id AS runId, task_id AS taskId, relation FROM run_task_links WHERE run_id = ? ORDER BY rowid').all(runId) as RunTaskLink[];
}

export function linksOfTask(db: Database, taskId: string): RunTaskLink[] {
    return db.query('SELECT run_id AS runId, task_id AS taskId, relation FROM run_task_links WHERE task_id = ? ORDER BY rowid').all(taskId) as RunTaskLink[];
}

/** Returns false when the link already existed. */
export function insertRunTaskLink(db: Database, link: RunTaskLink): boolean {
    return db.query('INSERT OR IGNORE INTO run_task_links (run_id, task_id, relation) VALUES (?, ?, ?)').run(link.runId, link.taskId, link.relation).changes > 0;
}

export function runIdsOfTask(db: Database, taskId: string): string[] {
    return (db.query('SELECT run_id FROM run_task_links WHERE task_id = ? GROUP BY run_id ORDER BY MIN(rowid)').all(taskId) as { run_id: string }[]).map(row => row.run_id);
}

/* ---------------------- Details the protocol does not show ---------------------- */

export type RunOutcome = 'done' | 'failed' | 'blocked';

export interface RunProcess {
    pid: number;
    pgid?: number;
    startedAt?: number;
}

/** What the runtime keeps about a run besides the entity clients see. */
export interface RunWork {
    /** Working directory the run's engine starts in; the project path when absent. */
    cwd?: string;
    idempotencyKey?: string;
    /** The user message or assignment of the turn that has not started yet. */
    nextPrompt?: string;
    /** How the run itself reported its end with `report_result`. */
    outcome?: RunOutcome;
    process?: RunProcess;
}

interface WorkRow {
    cwd: string | null;
    idempotency_key: string | null;
    next_prompt: string | null;
    outcome: RunOutcome | null;
    pid: number | null;
    pgid: number | null;
    process_started_at: number | null;
}

export function getRunWork(db: Database, runId: string): RunWork {
    const row = db.query('SELECT cwd, idempotency_key, next_prompt, outcome, pid, pgid, process_started_at FROM runs WHERE id = ?').get(runId) as WorkRow | null;

    if (!row) {
        return {};
    }

    return clean({
        cwd: row.cwd,
        idempotencyKey: row.idempotency_key,
        nextPrompt: row.next_prompt,
        outcome: row.outcome,
        process: row.pid === null ? undefined : clean({ pid: row.pid, pgid: row.pgid, startedAt: row.process_started_at }),
    }) as RunWork;
}

type WorkPatch = { [K in keyof RunWork]?: RunWork[K] | null };

/** Sets the given details; `null` clears one, a missing key leaves it. */
export function setRunWork(db: Database, runId: string, work: WorkPatch): void {
    const columns: [string, string | number | null][] = [];

    for (const [key, column] of [['cwd', 'cwd'], ['idempotencyKey', 'idempotency_key'], ['nextPrompt', 'next_prompt'], ['outcome', 'outcome']] as const) {
        if (work[key] !== undefined) {
            columns.push([column, work[key]]);
        }
    }

    if (work.process !== undefined) {
        columns.push(['pid', work.process?.pid ?? null], ['pgid', work.process?.pgid ?? null], ['process_started_at', work.process?.startedAt ?? null]);
    }

    if (columns.length > 0) {
        db.query(`UPDATE runs SET ${ columns.map(([column]) => `${ column } = ?`).join(', ') } WHERE id = ?`).run(...columns.map(([, value]) => value), runId);
    }
}

/** Runs with a recorded engine process, for cleaning up after a crash. */
export function listRunsWithProcess(db: Database): { runId: string; process: RunProcess }[] {
    const rows = db.query('SELECT id, pid, pgid, process_started_at FROM runs WHERE pid IS NOT NULL').all() as { id: string; pid: number; pgid: number | null; process_started_at: number | null }[];

    return rows.map(row => ({ runId: row.id, process: clean({ pid: row.pid, pgid: row.pgid, startedAt: row.process_started_at }) as RunProcess }));
}

/* ----------------------------------- Mailbox ----------------------------------- */

/** A finished child waiting to be told to its parent. Written in the transaction that finishes the child. */
export function insertMailbox(db: Database, runId: string, childRunId: string): void {
    db.query('INSERT OR IGNORE INTO run_mailbox (run_id, child_run_id, created_at) VALUES (?, ?, ?)').run(runId, childRunId, Date.now());
}

/** Children of `runId` whose result the parent has not seen yet, oldest first. */
export function pendingMailbox(db: Database, runId: string): { id: number; childRunId: string }[] {
    const rows = db.query('SELECT id, child_run_id FROM run_mailbox WHERE run_id = ? AND delivered_at IS NULL ORDER BY id').all(runId) as { id: number; child_run_id: string }[];

    return rows.map(row => ({ id: row.id, childRunId: row.child_run_id }));
}

export function markMailboxDelivered(db: Database, ids: number[]): void {
    const update = db.query('UPDATE run_mailbox SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL');
    const now = Date.now();

    for (const id of ids) {
        update.run(now, id);
    }
}

/** Marks the entries of these children delivered: the parent has seen them some other way (`run_wait`, `run_cancel`). */
export function markChildrenDelivered(db: Database, runId: string, childRunIds: string[]): void {
    const update = db.query('UPDATE run_mailbox SET delivered_at = ? WHERE run_id = ? AND child_run_id = ? AND delivered_at IS NULL');
    const now = Date.now();

    for (const childRunId of childRunIds) {
        update.run(now, runId, childRunId);
    }
}

/** Parents with undelivered results, for waking them after a restart. */
export function runsWithPendingMailbox(db: Database): string[] {
    return (db.query('SELECT DISTINCT run_id FROM run_mailbox WHERE delivered_at IS NULL').all() as { run_id: string }[]).map(row => row.run_id);
}

/* ------------------------------- Engine pauses -------------------------------- */

export function listEnginePauses(db: Database): { engine: string; until: number }[] {
    return db.query('SELECT engine, until FROM engine_pauses').all() as { engine: string; until: number }[];
}

/** Remembers that an engine accepts no work until `until` (epoch ms); `undefined` removes the pause. */
export function saveEnginePause(db: Database, engine: string, until: number | undefined): void {
    if (until === undefined) {
        db.query('DELETE FROM engine_pauses WHERE engine = ?').run(engine);
    }
    else {
        db.query('INSERT INTO engine_pauses (engine, until) VALUES (?, ?) ON CONFLICT(engine) DO UPDATE SET until = excluded.until').run(engine, until);
    }
}
