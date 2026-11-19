import { isTerminalRunStatus } from '@clowdy/protocol';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { listItems, nextSeq } from '../db/items';
import { countActiveSpawnedChildren, countSpawnedChildren, depthOf, findSpawnedChild, getRun, getRunWork, listActiveRuns, listRunsWithProcess, markMailboxDelivered, pendingMailbox, setRunWork } from '../db/runs';
import { appendItem } from '../domain/items';
import { CommandError, conflict, EngineFailure, errorMessage, invalid } from '../errors';
import { conversationRecord } from './history';
import { backoffDelay, engineName, formatMoment, parseLimit, sleep } from './limits';
import { NativeAgents } from './native';
import { describeProcess, killSurvivor } from './processes';
import { CONTINUE_MESSAGE, firstMessage, skillPrompt, systemPrompt } from './prompts';
import { childReport, wakeMessage } from './reports';
import { ASK_USER } from './tools';
import { STOPPED_TOOL, TurnWriter, UNFINISHED_TOOL } from './writer';

import type { ChatMode, EngineId, Run, RunContext, RunRole, Task } from '@clowdy/protocol';
import type { Config } from '../config';
import type { RunOutcome } from '../db/runs';
import type { EngineRegistry, EngineSession, ToolDefinition } from '../engine/types';
import type { Store } from '../store';
import type { LimitSignal } from './limits';
import type { RunService } from './service';

/** Runs nested below a root, counting the root: an orchestrator starts executors and verifiers, and they start nothing. */
export const MAX_DEPTH = 2;
/** A run that fails this many times in a row on passing engine errors (overload, rate limit) is failed for good. */
const MAX_TRANSIENT_FAILURES = 4;

export interface DriverDeps {
    store: Store;
    config: Config;
    runs: RunService;
    engines: EngineRegistry;
    /** The tools a run gets: an orchestrator's, or an executor's or verifier's. */
    tools(run: Run, mode: ChatMode): ToolDefinition[];
    /** The message that makes the engine's agent compact its conversation, or `undefined` for an agent with no such command. */
    compactCommand(engine: EngineId): string | undefined;
}

export interface SpawnInput {
    parent: Run;
    tasks: Task[];
    prompt: string;
    role: Extract<RunRole, 'executor' | 'verifier'>;
    idempotencyKey: string;
    engine?: EngineId;
    model?: string;
    cwd?: string;
}

/** How a run ended its work with `report_result`. */
export interface Report {
    status: RunOutcome;
    summary: string;
}

interface LiveRun {
    session?: EngineSession;
    engine?: EngineId;
    /** Writes the running turn's stream; a steer the agent took closes its open message. */
    writer?: TurnWriter;
    /** Aborts this turn's session without cancelling the run. */
    turn?: AbortController;
    /** Set when the engine is at its subscription limit: the turn stops and the run waits for the reset. */
    pausedUntil?: number;
    report?: Report;
    reportTimer?: ReturnType<typeof setTimeout>;
    native?: NativeAgents;
    /** What the running turn was told, so a retry before the session id is known can say it again. */
    prompt?: string;
}

type Retry = { kind: 'limit'; until: number } | { kind: 'transient'; delayMs: number; message: string };

const firstLine = (text: string) => text.split('\n')[0].trim().slice(0, 300);

/**
 * Drives runs: takes a run through its slot, feeds the engine session one turn at a time, maps its events to stream
 * items, and settles the run's status. A turn that ends while children work parks the run (`waiting_children`); a
 * later wake-up starts a new turn of the same session. Everything durable goes through `RunService` and the stream writer.
 */
export class RunDriver {
    /** Called once a turn's engine session has started, with the run's id: messages steered while the run had no session can go to it now. */
    onTurnStarted: (runId: string) => void = () => undefined;
    private live = new Map<string, LiveRun>();
    /** The last flight of each run. A new one starts behind it, so a run never has two turns at once. */
    private flights = new Map<string, Promise<void>>();
    /** Engine sessions started and not yet closed. */
    private sessions = 0;

    constructor(private deps: DriverDeps) {}

    /* --------------------------------- Starting -------------------------------- */

    /** Creates a run for an orchestrator's `run_spawn` and starts it once the surrounding transaction commits. A repeated key returns the first run. */
    spawn(input: SpawnInput): { run: Run; duplicate: boolean } {
        const { store, runs, config } = this.deps;

        return store.tx(() => {
            const { parent, tasks } = input;
            const status = runs.require(parent.id).status;

            // A cancelled orchestrator's session may still deliver a tool call: it must not start work nobody is watching.
            if (isTerminalRunStatus(status)) {
                throw conflict(`${ parent.name } is ${ status } and cannot start more runs`);
            }

            const existing = findSpawnedChild(store.db, parent.id, input.idempotencyKey);

            if (existing) {
                return { run: existing, duplicate: true };
            }

            if (depthOf(store.db, parent.id) + 2 > MAX_DEPTH) {
                throw conflict(`Runs nest ${ MAX_DEPTH } levels deep at most: ${ parent.name } is itself a child run and cannot start more`);
            }

            // Sub-agents inside the orchestrator's own session count toward neither limit.
            if (countActiveSpawnedChildren(store.db, parent.id) >= config.maxActiveChildren) {
                throw conflict(`${ parent.name } has ${ config.maxActiveChildren } runs unfinished, the most it may have at once. End your turn so they can finish, then start the rest.`);
            }

            if (countSpawnedChildren(store.db, parent.id) >= config.maxChildren) {
                throw conflict(`${ parent.name } already started ${ config.maxChildren } runs, the most one orchestrator may start over the life of its chat (finished ones count too); continue the work in a new chat`);
            }

            if (input.cwd !== undefined && !(isAbsolute(input.cwd) && statSync(input.cwd, { throwIfNoEntry: false })?.isDirectory())) {
                throw invalid(`cwd must be the absolute path of an existing folder: ${ input.cwd }`);
            }

            if (input.role === 'executor') {
                for (const task of tasks) {
                    // A chat started from a task is itself assigned to it; the orchestrator may still hand the work to an executor.
                    const [active] = runs.activeRunsOfTask(task.id, parent.id);

                    if (active) {
                        throw new CommandError('already_running', `Task ${ task.key } already has an active run (${ active.name }). Wait for it, or run_cancel it first.`);
                    }
                }
            }

            const [first] = tasks;
            const engine = input.engine ?? parent.engine;
            // A child on the parent's own engine goes on running what the chat chose. On another engine the parent's model means nothing,
            // and a model the child names has levels of its own; those children get what they name, else the project's model (`createRun`).
            const inherits = engine === parent.engine && input.model === undefined;
            const run = runs.createRun({
                project: runs.projectOf(parent),
                role: input.role,
                origin: 'spawned',
                summary: tasks.length > 1 ? `${ first.title } (+${ tasks.length - 1 } more)` : first.title,
                parent,
                engine,
                model: inherits ? parent.model : input.model,
                effort: inherits ? parent.effort : undefined,
                cwd: input.cwd,
                idempotencyKey: input.idempotencyKey,
                nextPrompt: firstMessage(input.role, runs.modeOf(parent), input.prompt),
                ...(input.role === 'executor' ? { assigned: tasks } : { verifies: tasks }),
            });
            const keys = tasks.map(task => task.key).join(', ');

            appendItem(store, run.id, { kind: 'user', text: input.prompt });
            runs.note(parent.id, run.status === 'blocked' ? `${ run.name } is waiting: ${ run.statusReason }` : `Started ${ run.name } on ${ keys }`);
            this.launch(run.id);

            return { run, duplicate: false };
        });
    }

    /**
     * Starts the next turn of a `queued` or `blocked` run once the surrounding transaction commits. The turn begins with
     * the message stored on the run, followed by the results of finished children it has not seen.
     */
    launch(runId: string): void {
        this.deps.store.afterCommit(() => {
            const live: LiveRun = {};
            const previous = this.flights.get(runId) ?? Promise.resolve();
            const flight: Promise<void> = previous
                .then(() => this.drive(runId, live))
                .catch(error => console.error(`[clowdy] driving run ${ runId } failed:`, error))
                .finally(() => {
                    if (this.flights.get(runId) === flight) {
                        this.flights.delete(runId);
                    }
                });

            this.live.set(runId, live);
            this.flights.set(runId, flight);
        });
    }

    /** After a restart: runs that were only waiting (for a slot, a dependency, a reset) wait again. */
    resumeWaiting(): void {
        for (const run of listActiveRuns(this.deps.store.db)) {
            if (run.status === 'queued' || run.status === 'blocked') {
                this.launch(run.id);
            }
        }
    }

    /**
     * Hands `text` to the turn the run is working on, as a steer, when its session can take one; resolves whether the agent took it. `taken` runs in the
     * transaction that closes the turn's open message, so what the agent says from then on comes after whatever `taken` writes (the person's bubble).
     * A run that waits (for a slot, an answer, a reset) has no turn to steer.
     */
    async steer(runId: string, text: string, taken: () => void): Promise<boolean> {
        const live = this.live.get(runId);
        const session = live?.session;
        const writer = live?.writer;

        if (!session?.steer || !writer || this.deps.runs.require(runId).status !== 'running') {
            return false;
        }

        let accepted = false;

        try {
            accepted = await session.steer(text);
        }
        catch (error) {
            console.warn(`[clowdy] steering run ${ runId } failed: ${ errorMessage(error) }`);
        }

        if (accepted) {
            this.deps.store.tx(() => {
                writer.end();
                taken();
            });
        }

        return accepted;
    }

    /**
     * Whether the run's turn, the one that waits to start or the one in flight, is the agent's compact command (`chat.compact`): asking for another would
     * only compact what is being compacted.
     */
    isCompacting(runId: string): boolean {
        const command = this.deps.compactCommand(this.deps.runs.require(runId).engine);
        const live = this.live.get(runId);

        return command !== undefined && ((live?.session !== undefined && live.prompt === command) || getRunWork(this.deps.store.db, runId).nextPrompt === command);
    }

    /** `report_result`: the run's work is over with this outcome. The session gets a moment to end its turn, then is closed. */
    report(runId: string, report: Report): void {
        const live = this.live.get(runId);

        if (!live?.session) {
            throw new Error('This run has no live session to report from');
        }

        if (live.report) {
            throw new Error('This run already reported its result');
        }

        if (isTerminalRunStatus(this.deps.runs.require(runId).status)) {
            throw new Error('This run was stopped; its result is not recorded');
        }

        const { session } = live;

        live.report = report;
        live.reportTimer = setTimeout(() => void Promise.resolve(session.close()).catch(() => undefined), this.deps.config.timings.killGraceMs);
    }

    /** Aborts every live run without changing statuses (the next start marks them interrupted) and waits for them to settle. */
    async stop(): Promise<void> {
        const { runs, config, store } = this.deps;

        runs.abortAll();
        await Promise.race([Promise.allSettled([...this.flights.values()]), Bun.sleep(2 * config.timings.killGraceMs)]);

        for (const { process } of listRunsWithProcess(store.db)) {
            await killSurvivor(process, config.timings.killGraceMs);
        }
    }

    /* ---------------------------------- Driving --------------------------------- */

    private async drive(runId: string, live: LiveRun): Promise<void> {
        const { runs } = this.deps;
        const signal = runs.register(runId);
        let failures = 0;

        try {
            // Cancelled or taken over while this flight waited behind the previous one.
            if (!['queued', 'blocked'].includes(runs.require(runId).status)) {
                return;
            }

            await runs.waitUnblocked(runId, signal);

            for (;;) {
                await runs.acquireSlot(runId, signal);

                const retry = await this.turn(runId, live, signal, failures);

                if (!retry) {
                    return;
                }

                failures += retry.kind === 'transient' ? 1 : 0;
                await this.waitToRetry(runId, live, retry, signal);
            }
        }
        catch (error) {
            if (!signal.aborted) {
                this.fail(runId, error);
            }
        }
        finally {
            runs.unregister(runId);

            if (this.live.get(runId) === live) {
                this.live.delete(runId);
            }
        }
    }

    /** One engine session, from its start until the turn ends. Returns what to wait for when the turn has to be repeated. */
    private async turn(runId: string, live: LiveRun, signal: AbortSignal, failures: number): Promise<Retry | undefined> {
        const { store, runs, engines, config } = this.deps;
        const deadline = Date.now() + 2 * config.timings.killGraceMs;

        // The sessions of runs that just ended or were cancelled still shut down while the next runs already hold their
        // slots, so a start waits for them before it counts as a runaway. No await between this check and `sessions++`.
        while (this.sessions >= config.maxProcesses) {
            if (Date.now() >= deadline) {
                throw new EngineFailure(`${ this.sessions } engine processes are alive, the most this daemon allows (CLOWDY_MAX_PROCESSES); the run was not started`);
            }

            await sleep(25, signal);
        }

        const run = runs.require(runId);
        const project = runs.projectOf(run);
        const mode = runs.modeOf(run);
        const engine = engines.get(run.engine);

        if (!engine) {
            throw new EngineFailure(`The ${ run.engine } engine is not available in this daemon`);
        }

        // The stream as it is before this turn adds its own lines (a note per child that finished): what the agent was told so far.
        const told = nextSeq(store.db, runId) - 1;
        const work = getRunWork(store.db, runId);
        const pending = pendingMailbox(store.db, runId);
        const children = pending.flatMap(entry => getRun(store.db, entry.childRunId) ?? []);
        const prompt = [work.nextPrompt, children.length > 0 && wakeMessage(store, children)].filter(Boolean).join('\n\n') || CONTINUE_MESSAGE;

        for (const child of children) {
            runs.note(runId, `${ child.name } finished: ${ childReport(store, child).state }`);
        }

        const turnAbort = new AbortController();
        const writer = new TurnWriter(store, runId);

        live.engine = run.engine;
        live.writer = writer;
        live.turn = turnAbort;
        live.native = new NativeAgents(store, runs, run);
        live.prompt = prompt;

        // The message this turn sends is in the stream already; the record leaves it out, as the agent gets it in the prompt.
        const incoming = [prompt];
        const session = engine.start({
            cwd: work.cwd ?? project.path,
            prompt,
            systemPrompt: [systemPrompt(run.role, mode, project), skillPrompt(run.role, config.systemSkillsDir)].filter(Boolean).join('\n\n'),
            resumeSessionId: run.sessionId,
            ...(run.sessionId && { history: () => conversationRecord(listItems(store.db, runId, 0).filter(item => item.seq <= told), incoming) }),
            model: run.model,
            effort: run.effort,
            tools: this.deps.tools(run, mode),
            signal: AbortSignal.any([signal, turnAbort.signal]),
        });

        this.sessions++;
        live.session = session;
        store.tx(() => {
            setRunWork(store.db, runId, { nextPrompt: null });
            markMailboxDelivered(store.db, pending.map(entry => entry.id));
        });

        this.onTurnStarted(runId);

        try {
            this.settle(runId, live, await this.consume(run, session, writer, live));

            return undefined;
        }
        catch (error) {
            if (live.report) {
                this.settle(runId, live, undefined);

                return undefined;
            }

            if (live.pausedUntil !== undefined && !signal.aborted) {
                return { kind: 'limit', until: live.pausedUntil };
            }

            if (error instanceof EngineFailure && error.retryable && failures < MAX_TRANSIENT_FAILURES && !signal.aborted) {
                runs.limits.transientFailure(run.engine);

                return { kind: 'transient', delayMs: backoffDelay(failures + 1, config.timings.retryBaseMs), message: error.message };
            }

            throw error;
        }
        finally {
            clearTimeout(live.reportTimer);
            // Whatever the agent left running ends with the turn: a Stop or a failure mid-call would otherwise leave the call shimmering.
            writer.finish(signal.aborted ? STOPPED_TOOL : UNFINISHED_TOOL);
            live.native.finish();
            live.session = undefined;
            live.writer = undefined;
            live.pausedUntil = undefined;
            await Promise.resolve(session.close()).catch(() => undefined);
            this.sessions--;
            runs.setProcess(runId, null);
        }
    }

    /** Maps the session's events until it ends the turn; returns the final report. */
    private async consume(run: Run, session: EngineSession, writer: TurnWriter, live: LiveRun): Promise<string | undefined> {
        const { runs } = this.deps;
        const native = live.native as NativeAgents;
        let context: RunContext | undefined;

        try {
            for await (const event of session) {
                switch (event.type) {
                    case 'session':
                        runs.setSessionId(run.id, event.sessionId);
                        break;
                    case 'process':
                        runs.setProcess(run.id, describeProcess({ pid: event.pid, pgid: event.pgid, startedAt: event.startedAt }));
                        break;
                    case 'text':
                        if (event.agentId === undefined) {
                            writer.text(event.delta, event.done);
                        }
                        else {
                            native.stream({ ...event, agentId: event.agentId });
                        }

                        break;
                    case 'tool':
                        // `ask_user` shows as a question card instead.
                        if (event.name === ASK_USER) {
                            break;
                        }

                        if (event.agentId === undefined) {
                            writer.tool(event);
                        }
                        else {
                            native.stream({ ...event, agentId: event.agentId });
                        }

                        break;
                    case 'subagent':
                        native.state(event);
                        break;
                    case 'limit':
                        this.onLimit(run, parseLimit(event));
                        break;
                    case 'usage':
                        runs.addUsage(run.id, event);
                        break;
                    case 'context':
                        context = { used: event.used, size: event.size };
                        runs.setContext(run.id, context);
                        break;
                    case 'done':
                        writer.end();

                        return event.result;
                    case 'error':
                        throw new EngineFailure(event.message, event.retryable, event.code);
                }
            }

            throw new EngineFailure('The engine ended without a result');
        }
        finally {
            // However the turn ended (a result, a failure, a cancel, an engine that threw), the number shown afterwards is the last one it reported,
            // whatever the throttle skipped on the way.
            if (context) {
                runs.setContext(run.id, context, true);
            }
        }
    }

    /* ----------------------------- Limits and retries ---------------------------- */

    /** A subscription signal. A warning makes the engine run fewer runs at once; a rejection stops it and every live run of it until the reset. */
    private onLimit(run: Run, signal: LimitSignal): void {
        const { store, runs } = this.deps;
        const { limits } = runs;

        if (signal.status === 'warning') {
            limits.warn(run.engine);

            return;
        }

        const wasPaused = limits.pausedUntil(run.engine) !== undefined;
        const until = limits.pause(run.engine, signal.resetsAt);
        const now = limits.now();

        if (!wasPaused) {
            const far = until - now > 24 * 3_600_000;

            store.tx(() => store.emit(run.projectId, {
                type: 'notice',
                level: far ? 'error' : 'warn',
                text: `${ engineName(run.engine) } reached its usage limit${ far ? ` and is paused until ${ formatMoment(until, now) }, more than a day from now` : `; its runs continue at ${ formatMoment(until, now) }` }`,
            }));
        }

        for (const [runId, live] of this.live) {
            // A run that waits for an answer or a slot is not using the engine; the scheduler holds it until the reset.
            if (live.engine === run.engine && live.session && runs.require(runId).status === 'running') {
                live.pausedUntil = until;
                live.turn?.abort();
            }
        }
    }

    /** Parks the run `blocked` until the reason to wait is over, and sets up the message that continues it. */
    private async waitToRetry(runId: string, live: LiveRun, retry: Retry, signal: AbortSignal): Promise<void> {
        const { store, runs } = this.deps;
        const run = runs.require(runId);
        const now = runs.limits.now();

        // A compact turn is its command and nothing else (`chat.compact`); nothing was compacted, so a "continue" would have the agent resume work that does not exist.
        const compacting = live.prompt !== undefined && live.prompt === this.deps.compactCommand(run.engine);

        store.tx(() => {
            // Without a session there is nothing to continue: the turn starts again from its own message.
            setRunWork(store.db, runId, { nextPrompt: run.sessionId && !compacting ? CONTINUE_MESSAGE : live.prompt });
            runs.setStatus(runId, 'blocked', {
                reason: retry.kind === 'limit'
                    ? `${ engineName(run.engine) } is at its usage limit until ${ formatMoment(retry.until, now) }; this run continues then`
                    : `${ engineName(run.engine) } is busy (${ firstLine(retry.message) }); trying again in ${ Math.ceil(retry.delayMs / 1000) } s`,
            });
        });

        if (retry.kind === 'limit') {
            await runs.limits.untilResumed(run.engine, signal);
        }
        else {
            await sleep(retry.delayMs, signal);
        }
    }

    /* ---------------------------------- Settling --------------------------------- */

    /**
     * The turn ended normally. A run that reported ends with its report. An orchestrator with children still working,
     * or with results it has not seen, parks in `waiting_children` and is woken for them. Anything else succeeds.
     */
    private settle(runId: string, live: LiveRun, result: string | undefined): void {
        const { store, runs } = this.deps;

        store.tx(() => {
            live.native?.finish();

            const run = runs.require(runId);

            if (isTerminalRunStatus(run.status)) {
                return;
            }

            const { report } = live;

            if (report) {
                setRunWork(store.db, runId, { outcome: report.status });

                if (report.status === 'done') {
                    runs.setStatus(runId, 'succeeded', { result: report.summary });
                }
                else {
                    runs.setStatus(runId, 'failed', { result: report.summary, error: `${ report.status === 'blocked' ? 'Blocked: ' : '' }${ firstLine(report.summary) }` });
                }

                return;
            }

            if (run.role === 'orchestrator') {
                const active = countActiveSpawnedChildren(store.db, runId);
                const unseen = pendingMailbox(store.db, runId).length;

                if (active > 0 || unseen > 0) {
                    runs.setStatus(runId, 'waiting_children', { reason: active > 0 ? `Waiting for ${ active } child ${ active === 1 ? 'run' : 'runs' }` : 'Child results are ready' });

                    if (unseen > 0) {
                        store.afterCommit(() => runs.onChildSettled(runId));
                    }

                    return;
                }
            }

            runs.setStatus(runId, 'succeeded', { result });
        });
    }

    private fail(runId: string, error: unknown): void {
        const { store, runs } = this.deps;
        const message = errorMessage(error);
        // The engine's class of the failure stays on the run, so the app can offer what fixes it (Compact for a context that overflowed).
        const failureCode = error instanceof EngineFailure ? error.code : undefined;

        store.tx(() => {
            if (isTerminalRunStatus(runs.require(runId).status)) {
                return;
            }

            appendItem(store, runId, { kind: 'error', text: message });
            runs.setStatus(runId, 'failed', { error: message, ...(failureCode !== undefined && { failureCode }) });
        });
    }
}
