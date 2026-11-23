import { ACTIVE_RUN_STATUSES } from '@clowdy/protocol';

import { clean, parseJson, toJson } from './json';

import type { BackgroundItem, Run, RunContext, RunOrigin, RunRole, RunTaskLink, RunUsage } from '@clowdy/protocol';
import type { Database } from 'bun:sqlite';

interface RunRow {
    id: string;
    project_id: string;
    parent_run_id: string | null;
    root_run_id: string;
    chat_id: string | null;
    role: RunRole;
    origin: RunOrigin | null;
    parent_tool_call_id: string | null;
    can_stop_alone: number | null;
    awaiting_user: number | null;
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
    failure_code: string | null;
    usage: string | null;
    context: string | null;
    background: string | null;
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
    parentToolCallId: row.parent_tool_call_id,
    canStopAlone: row.can_stop_alone === 1 ? true : null,
    awaitingUser: row.awaiting_user === 1 ? true : null,
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
    failureCode: row.failure_code,
    usage: parseJson<RunUsage>(row.usage),
    context: parseJson<RunContext>(row.context),
    background: parseJson<BackgroundItem[]>(row.background),
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
        INSERT INTO runs (id, project_id, parent_run_id, root_run_id, chat_id, role, origin, parent_tool_call_id, can_stop_alone, awaiting_user, name, summary, status,
            status_reason, engine, model, effort, session_id, worktree, result, error, failure_code, usage, context, background, created_at, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, status = excluded.status, status_reason = excluded.status_reason,
            model = excluded.model, effort = excluded.effort, session_id = excluded.session_id, worktree = excluded.worktree, result = excluded.result,
            error = excluded.error, failure_code = excluded.failure_code, usage = excluded.usage, context = excluded.context, background = excluded.background,
            awaiting_user = excluded.awaiting_user, started_at = excluded.started_at, finished_at = excluded.finished_at
    `).run(
        run.id, run.projectId, run.parentRunId ?? null, run.rootRunId, run.chatId ?? null, run.role, run.origin ?? null, run.parentToolCallId ?? null, run.canStopAlone ? 1 : null, run.awaitingUser ? 1 : null,
        run.name, run.summary, run.status, run.statusReason ?? null, run.engine, run.model ?? null, run.effort ?? null, run.sessionId ?? null, toJson(run.worktree),
        run.result ?? null, run.error ?? null, run.failureCode ?? null, toJson(run.usage), toJson(run.context), toJson(run.background),
        run.createdAt, run.startedAt ?? null, run.finishedAt ?? null
    );
}

/**
 * Deletes runs by id in one statement, which SQLite checks at its end, so a parent and its children may go together. Their streams and run-task links go
 * with them; an artifact keeps its row and loses the run.
 */
export function deleteRuns(db: Database, ids: readonly string[]): void {
    if (ids.length > 0) {
        db.query('DELETE FROM runs WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(ids));
    }
}

/**
 * The sub-agent runs a rewrite of `runId`'s stream cuts off, with every sub-agent they started: those whose parent call is one of `toolCallIds` (the calls
 * of the items that go), and those no call is recorded for that began at or after `since` (epoch ms, the time of the first item that goes), since an
 * engine may leave the call out and a sub-agent only starts inside a turn, after the message that began it.
 */
export function runsStartedAfter(db: Database, runId: string, toolCallIds: readonly string[], since: number): string[] {
    const rows = db.query(`
        WITH RECURSIVE tree(id) AS (
            SELECT id FROM runs WHERE parent_run_id = ?1 AND (parent_tool_call_id IN (SELECT value FROM json_each(?2)) OR (parent_tool_call_id IS NULL AND created_at >= ?3))
            UNION ALL
            SELECT r.id FROM runs r JOIN tree ON r.parent_run_id = tree.id
        )
        SELECT id FROM tree
    `).all(runId, JSON.stringify(toolCallIds), since) as { id: string }[];

    return rows.map(row => row.id);
}

/** Clears what the runs had open to the person: at startup nothing is, since the sessions that asked are gone. */
export function clearAwaitingUser(db: Database): void {
    db.run('UPDATE runs SET awaiting_user = NULL WHERE awaiting_user IS NOT NULL');
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

export interface RunProcess {
    pid: number;
    pgid?: number;
    startedAt?: number;
}

/** What the runtime keeps about a run besides the entity clients see. */
export interface RunWork {
    /** Working directory the run's engine starts in; absent, the folder its chat works in, else the project's main folder (`workingFolder` in `runs/driver.ts`). */
    cwd?: string;
    /** The user message or assignment of the turn that has not started yet. */
    nextPrompt?: string;
    process?: RunProcess;
    /** What the run had open in the background when a restart ended its session: the next turn's message names it, then the record is cleared. */
    lostBackground?: BackgroundItem[];
}

interface WorkRow {
    cwd: string | null;
    next_prompt: string | null;
    pid: number | null;
    pgid: number | null;
    process_started_at: number | null;
    lost_background: string | null;
}

export function getRunWork(db: Database, runId: string): RunWork {
    const row = db.query('SELECT cwd, next_prompt, pid, pgid, process_started_at, lost_background FROM runs WHERE id = ?').get(runId) as WorkRow | null;

    if (!row) {
        return {};
    }

    return clean({
        cwd: row.cwd,
        nextPrompt: row.next_prompt,
        process: row.pid === null ? undefined : clean({ pid: row.pid, pgid: row.pgid, startedAt: row.process_started_at }),
        lostBackground: parseJson<BackgroundItem[]>(row.lost_background),
    }) as RunWork;
}

type WorkPatch = { [K in keyof RunWork]?: RunWork[K] | null };

/** Sets the given details; `null` clears one, a missing key leaves it. */
export function setRunWork(db: Database, runId: string, work: WorkPatch): void {
    const columns: [string, string | number | null][] = [];

    for (const [key, column] of [['cwd', 'cwd'], ['nextPrompt', 'next_prompt']] as const) {
        if (work[key] !== undefined) {
            columns.push([column, work[key]]);
        }
    }

    if (work.process !== undefined) {
        columns.push(['pid', work.process?.pid ?? null], ['pgid', work.process?.pgid ?? null], ['process_started_at', work.process?.startedAt ?? null]);
    }

    if (work.lostBackground !== undefined) {
        columns.push(['lost_background', work.lostBackground === null ? null : toJson(work.lostBackground)]);
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
