import { ACTIVE_RUN_STATUSES, isTerminalRunStatus } from '@clowdy/protocol';

import { getChat } from '../db/chats';
import { findQuestion } from '../db/items';
import { getProject } from '../db/projects';
import { activeSubtree, countActiveRuns, countRunsWithRole, getRun, getRunWork, insertMailbox, linksOfRun, linksOfTask, listActiveRuns, listEnginePauses, listRunsWithProcess, pendingMailbox, saveEnginePause, setRunWork, upsertRun } from '../db/runs';
import { getTask } from '../db/tasks';
import { appendItem, updateItem } from '../domain/items';
import { categoryOf, linkRunTask, moveTask, requireTask } from '../domain/tasks';
import { conflict, invalid, notFound, unavailable } from '../errors';
import { newId } from '../ids';
import { EngineLimits } from './limits';
import { killSurvivor, signalProcess } from './processes';
import { QUEUE_REASON, Scheduler } from './scheduler';
import { canTransition, NEEDS_REASON } from './transitions';

import type { ChatMode, EngineId, Project, QuestionOption, Run, RunContext, RunRole, RunStatus, RunUsage, Task } from '@clowdy/protocol';
import type { Config } from '../config';
import type { RunProcess } from '../db/runs';
import type { EngineRegistry } from '../engine/types';
import type { Store } from '../store';

const CANCEL_REASON = 'Cancelled by user';

/** Committed events that can change what a waiting run is waiting for. */
const RELEVANT_EVENTS = new Set(['run.upserted', 'task.upserted', 'task.deleted', 'link.runTask']);

export interface NewRun {
    project: Project;
    role: RunRole;
    summary: string;
    parent?: Run;
    /** `spawned` for a run an orchestrator started with `run_spawn`. */
    origin?: 'spawned';
    chatId?: string;
    engine?: EngineId;
    model?: string;
    /** The reasoning level, in the engine's own spelling. */
    effort?: string;
    /** Where the engine works; the project's folder when absent. */
    cwd?: string;
    /** The same key under the same parent never creates a second run. */
    idempotencyKey?: string;
    /** What the run's first turn is told. */
    nextPrompt?: string;
    /** Tasks the run executes. Unfinished dependencies of these tasks block the run. */
    assigned?: Task[];
    /** Tasks the run checks. Verifiers wait for nothing: the work they check is already done. */
    verifies?: Task[];
}

export interface StatusOptions {
    reason?: string;
    result?: string;
    error?: string;
}

const isActive = (status: RunStatus) => ACTIVE_RUN_STATUSES.includes(status);

const ROLE_NAMES: Record<RunRole, string> = { orchestrator: 'Orchestrator', executor: 'Executor', verifier: 'Verifier' };

/** Everything about a run's life that is not the engine conversation: creation, the status machine, slots, waiting, cancelling. */
export class RunService {
    readonly limits: EngineLimits;
    /** Called after the commit in which a run started by `run_spawn` finished, with its parent's id. */
    onChildSettled: (parentRunId: string) => void = () => undefined;
    private scheduler: Scheduler;
    private controllers = new Map<string, AbortController>();
    private answers = new Map<string, (answer: string) => void>();
    /** Runs with a question card open: a run asks one question at a time, because a reply wakes the run and a second open card could no longer be answered. */
    private asking = new Set<string>();
    private ladders = new Set<ReturnType<typeof setTimeout>>();

    constructor(private store: Store, private config: Config, private engines: EngineRegistry) {
        this.limits = new EngineLimits(config.engineCaps, {
            defaultCap: config.defaultEngineCap,
            store: { pauses: listEnginePauses(store.db), save: (engine, until) => saveEnginePause(store.db, engine, until) },
            jitterMs: config.timings.pauseJitterMs,
        });
        this.scheduler = new Scheduler(
            store,
            config,
            this.limits,
            runId => this.setStatus(runId, 'running'),
            (runId, reason) => this.setStatus(runId, 'queued', { reason })
        );
    }

    require(runId: string): Run {
        const run = getRun(this.store.db, runId);

        if (!run) {
            throw notFound('Run', runId);
        }

        return run;
    }

    /* -------------------------------- Creating -------------------------------- */

    /** The engine a new run uses: an explicit choice, then the project's setting, then the daemon's default. */
    resolveEngine(project: Project, preferred?: EngineId): EngineId {
        const engine = preferred ?? project.settings.engine ?? this.config.engine;

        if (!this.engines.has(engine)) {
            throw unavailable(`The ${ engine } engine is not available in this daemon`);
        }

        return engine;
    }

    /** Inserts a run, `queued` or `blocked`, with its task links. The caller launches it. */
    createRun(input: NewRun): Run {
        return this.store.tx(() => {
            const { project, parent } = input;
            const assigned = input.assigned ?? [];
            const blockers = this.unfinishedDependencies(assigned);
            const id = newId('run');
            const number = countRunsWithRole(this.store.db, project.id, input.role) + 1;
            const engine = this.resolveEngine(project, input.engine);
            // The project's model belongs to the project's agent: another agent has other models.
            const model = input.model ?? (engine === this.resolveEngine(project) ? project.settings.model : undefined);
            const run: Run = {
                id,
                projectId: project.id,
                ...(parent && { parentRunId: parent.id }),
                rootRunId: parent?.rootRunId ?? id,
                ...(input.chatId && { chatId: input.chatId }),
                role: input.role,
                ...(input.origin && { origin: input.origin }),
                name: `${ ROLE_NAMES[input.role] } ${ String(number).padStart(2, '0') }`,
                summary: input.summary,
                status: blockers.length > 0 ? 'blocked' : 'queued',
                statusReason: blockers.length > 0 ? blockedReason(blockers) : QUEUE_REASON,
                engine,
                ...(model && { model }),
                ...(input.effort && { effort: input.effort }),
                createdAt: Date.now(),
            };

            upsertRun(this.store.db, run);
            setRunWork(this.store.db, id, { cwd: input.cwd, idempotencyKey: input.idempotencyKey, nextPrompt: input.nextPrompt });
            this.store.emit(project.id, { type: 'run.upserted', run });

            for (const task of assigned) {
                linkRunTask(this.store, project.id, { runId: id, taskId: task.id, relation: 'assigned' });
            }

            for (const task of input.verifies ?? []) {
                linkRunTask(this.store, project.id, { runId: id, taskId: task.id, relation: 'verifies' });
            }

            return run;
        });
    }

    /**
     * A sub-agent inside `parent`'s engine session, shown as a child run. It starts `running` without a slot: the
     * parent's process does its work. It ends with the parent's turn at the latest.
     */
    createNative(parent: Run, input: { name: string; summary: string }): Run {
        return this.store.tx(() => {
            const id = newId('run');
            const run: Run = {
                id,
                projectId: parent.projectId,
                parentRunId: parent.id,
                rootRunId: parent.rootRunId,
                role: 'executor',
                origin: 'native',
                name: input.name,
                summary: input.summary,
                status: 'running',
                engine: parent.engine,
                ...(parent.model && { model: parent.model }),
                ...(parent.effort && { effort: parent.effort }),
                createdAt: Date.now(),
                startedAt: Date.now(),
            };

            upsertRun(this.store.db, run);
            this.store.emit(run.projectId, { type: 'run.upserted', run });

            return run;
        });
    }

    /** The mode of the chat a run belongs to, which decides whether its orchestrator may ask the user. */
    modeOf(run: Run): ChatMode {
        const chatId = run.chatId ?? getRun(this.store.db, run.rootRunId)?.chatId;

        return (chatId ? getChat(this.store.db, chatId)?.mode : undefined) ?? 'autopilot';
    }

    /* ------------------------------ Status machine ----------------------------- */

    /** The only place a run's status changes: validates the transition, stamps times, syncs tasks, publishes. */
    setStatus(runId: string, status: RunStatus, options: StatusOptions = {}): Run {
        return this.store.tx(() => {
            const run = this.require(runId);
            const reason = options.reason ?? (status === 'queued' ? QUEUE_REASON : undefined);

            if (run.status === status && run.statusReason === reason) {
                return run;
            }

            if (!canTransition(run.status, status)) {
                throw new Error(`Illegal run transition ${ run.status } -> ${ status } for ${ runId }`);
            }

            if (NEEDS_REASON.includes(status) && !reason) {
                throw new Error(`A run in ${ status } needs a status reason (${ runId })`);
            }

            const now = Date.now();
            const next: Run = { ...run, status };

            if (reason) {
                next.statusReason = reason;
            }
            else {
                delete next.statusReason;
            }

            if (status === 'running' && next.startedAt === undefined) {
                next.startedAt = now;
            }

            if (isTerminalRunStatus(status)) {
                next.finishedAt = now;

                if (options.result !== undefined) {
                    next.result = options.result;
                }

                if (options.error !== undefined) {
                    next.error = options.error;
                }
            }
            else if (isTerminalRunStatus(run.status)) {
                delete next.finishedAt;
                delete next.result;
                delete next.error;
                setRunWork(this.store.db, runId, { outcome: null });
            }

            upsertRun(this.store.db, next);
            this.store.emit(run.projectId, { type: 'run.upserted', run: next });
            this.syncTasks(run.status, next);

            if (isTerminalRunStatus(status) && run.origin === 'spawned' && run.parentRunId) {
                const parentId = run.parentRunId;

                // Written with the status, so a crash right after cannot lose the news; the parent hears it when it can.
                insertMailbox(this.store.db, parentId, runId);
                this.store.afterCommit(() => this.onChildSettled(parentId));
            }

            if (run.origin !== 'native' && (run.status === 'running' || status === 'queued')) {
                this.store.afterCommit(() => this.scheduler.tick());
            }

            return next;
        });
    }

    /** Puts a finished or parked run back in the queue for its next turn, with the message that starts it (a wake-up has none). */
    resume(runId: string, prompt?: string): Run {
        return this.store.tx(() => {
            setRunWork(this.store.db, runId, { nextPrompt: prompt ?? null });

            return this.setStatus(runId, 'queued');
        });
    }

    /** Whether children finished that the run has not been told about: whatever its next turn is asked, their results are added to it. */
    hasUnseenResults(runId: string): boolean {
        return pendingMailbox(this.store.db, runId).length > 0;
    }

    /** Task columns follow the work: started runs move tasks to active, a finished run to review, a dead one back to todo. */
    private syncTasks(previous: RunStatus, run: Run): void {
        const assigned = linksOfRun(this.store.db, run.id).filter(link => link.relation === 'assigned');

        for (const link of assigned) {
            const task = requireTask(this.store, link.taskId);
            const category = categoryOf(this.store, task);

            if (run.status === 'running' && previous !== 'running' && (category === 'todo' || category === 'backlog')) {
                moveTask(this.store, task.id, 'active');
            }
            else if (run.status === 'succeeded' && category === 'active') {
                moveTask(this.store, task.id, 'review');
            }
            else if (['failed', 'cancelled', 'interrupted'].includes(run.status) && category === 'active' && this.activeRunsOfTask(task.id, run.id).length === 0) {
                moveTask(this.store, task.id, 'todo');
            }
        }
    }

    /** Active runs assigned to or verifying the task, optionally leaving one out. */
    activeRunsOfTask(taskId: string, exceptRunId?: string): Run[] {
        return linksOfTask(this.store.db, taskId)
            .filter(link => link.relation !== 'created' && link.runId !== exceptRunId)
            .map(link => this.require(link.runId))
            .filter(run => isActive(run.status));
    }

    /** Unfinished dependencies of `tasks`, not counting tasks inside the same set. */
    private unfinishedDependencies(tasks: Task[]): Task[] {
        const own = new Set(tasks.map(task => task.id));
        const found = new Map<string, Task>();

        for (const task of tasks) {
            for (const id of task.dependsOn) {
                const dependency = getTask(this.store.db, id);

                if (dependency && !own.has(id) && categoryOf(this.store, dependency) !== 'done') {
                    found.set(id, dependency);
                }
            }
        }

        return [...found.values()];
    }

    /* ---------------------------- Slots and waiting ---------------------------- */

    /** Moves the run to `queued` if needed and resolves once the scheduler gave it a slot (`running`). */
    async acquireSlot(runId: string, signal: AbortSignal): Promise<void> {
        signal.throwIfAborted();

        const run = this.require(runId);

        if (run.status === 'running') {
            return;
        }

        if (isTerminalRunStatus(run.status)) {
            throw new Error(`Run ${ runId } is already ${ run.status }`);
        }

        if (run.status !== 'queued') {
            this.setStatus(runId, 'queued');
        }

        await this.scheduler.wait(runId, run.projectId, signal);
    }

    /** Re-evaluates slots, for example after a project's limit changed. */
    tick(): void {
        this.scheduler.tick();
    }

    /** Resolves after the next commit that can change run or task state, or after `timeoutMs`. */
    private nextChange(signal: AbortSignal, timeoutMs?: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const stop = () => {
                unsubscribe();
                clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
            };
            const onAbort = () => {
                stop();
                reject(signal.reason);
            };
            const unsubscribe = this.store.subscribe((events) => {
                if (events.some(event => RELEVANT_EVENTS.has(event.data.type))) {
                    stop();
                    resolve();
                }
            });
            const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
                stop();
                resolve();
            }, timeoutMs);

            if (signal.aborted) {
                onAbort();
            }
            else {
                signal.addEventListener('abort', onAbort, { once: true });
            }
        });
    }

    /** A run created `blocked` waits until every dependency of its tasks is done, then returns. Other runs return at once. */
    async waitUnblocked(runId: string, signal: AbortSignal): Promise<void> {
        while (this.require(runId).status === 'blocked') {
            const blockers = this.unfinishedDependencies(linksOfRun(this.store.db, runId).filter(link => link.relation === 'assigned').map(link => requireTask(this.store, link.taskId)));

            if (blockers.length === 0) {
                return;
            }

            this.setStatus(runId, 'blocked', { reason: blockedReason(blockers) });
            await this.nextChange(signal);
        }
    }

    /** Resolves when all the given runs are finished or after `timeoutMs`, and returns them as they are then. */
    async waitForRuns(runIds: string[], timeoutMs: number, signal: AbortSignal): Promise<Run[]> {
        const deadline = Date.now() + timeoutMs;

        for (;;) {
            const runs = runIds.map(id => this.require(id));
            const remaining = deadline - Date.now();

            if (runs.every(run => isTerminalRunStatus(run.status)) || remaining <= 0) {
                return runs;
            }

            await this.nextChange(signal, remaining);
        }
    }

    /* -------------------------------- Questions -------------------------------- */

    /**
     * Puts a question card into the run's stream, parks the run in `waiting_user` until `answerQuestion` delivers
     * the user's reply, then takes a slot again. Returns the reply.
     */
    async ask(runId: string, question: { text: string; options: QuestionOption[]; recommended?: string }, signal: AbortSignal): Promise<string> {
        if (this.asking.has(runId)) {
            throw new Error('Another question is waiting for the user. Ask one question at a time and wait for its answer.');
        }

        const questionId = newId('qst');

        this.asking.add(runId);

        try {
            this.store.tx(() => {
                appendItem(this.store, runId, { kind: 'question', questionId, ...question });
                this.setStatus(runId, 'waiting_user', { reason: 'Waiting for your answer' });
            });

            const answer = await new Promise<string>((resolve, reject) => {
                this.answers.set(questionId, resolve);
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });

            await this.acquireSlot(runId, signal);

            return answer;
        }
        finally {
            this.answers.delete(questionId);
            this.asking.delete(runId);
        }
    }

    /** Records the user's answer on the question item and wakes the run. */
    answerQuestion(runId: string, questionId: string, answer: string): void {
        this.store.tx(() => {
            const run = this.require(runId);
            const item = findQuestion(this.store.db, runId, questionId);

            if (!item || item.body.kind !== 'question') {
                throw notFound('Question', questionId);
            }

            if (item.body.answer !== undefined) {
                throw conflict('This question has already been answered');
            }

            const resolve = this.answers.get(questionId);

            if (run.status !== 'waiting_user' || !resolve) {
                throw conflict('The run is not waiting for an answer');
            }

            updateItem(this.store, runId, item.seq, { ...item.body, answer });
            this.store.afterCommit(() => resolve(answer));
        });
    }

    /* --------------------------------- Cancel --------------------------------- */

    /** The abort signal of a run's live work; cancelling the run aborts it. */
    register(runId: string): AbortSignal {
        const controller = new AbortController();

        this.controllers.set(runId, controller);

        return controller.signal;
    }

    unregister(runId: string): void {
        this.controllers.delete(runId);
    }

    /** Aborts everything in flight without touching statuses; used when the daemon stops. */
    abortAll(): void {
        for (const timer of this.ladders) {
            clearTimeout(timer);
        }

        this.ladders.clear();

        for (const controller of this.controllers.values()) {
            controller.abort();
        }
    }

    /**
     * Cancels the run and its active descendants, children first. History stays. Returns the cancelled run ids;
     * a run that is already finished cancels nothing. A sub-agent inside a session cannot be cancelled alone.
     */
    cancel(runId: string, reason = CANCEL_REASON): string[] {
        return this.store.tx(() => {
            const run = this.require(runId);

            if (run.origin === 'native' && isActive(run.status)) {
                throw conflict('A sub-agent runs inside its parent run; cancel the parent run instead');
            }

            const ids = activeSubtree(this.store.db, runId);

            for (const id of ids) {
                this.setStatus(id, 'cancelled', { reason });
            }

            this.store.afterCommit(() => {
                for (const id of ids) {
                    this.controllers.get(id)?.abort();
                    this.escalate(id);
                }
            });

            return ids;
        });
    }

    /**
     * A cancelled run's engine that does not stop when asked gets SIGTERM for its process group, then SIGKILL. It is
     * the process recorded now: the run may be resumed meanwhile, and its next turn's process is not this one.
     */
    private escalate(runId: string): void {
        const target = getRunWork(this.store.db, runId).process;

        if (!target) {
            return;
        }

        const { killGraceMs } = this.config.timings;
        const stillRecorded = () => getRunWork(this.store.db, runId).process?.pid === target.pid;
        const term = setTimeout(() => {
            this.ladders.delete(term);

            if (!stillRecorded()) {
                return;
            }

            signalProcess(target, 'SIGTERM');

            const kill = setTimeout(() => {
                this.ladders.delete(kill);

                if (stillRecorded()) {
                    signalProcess(target, 'SIGKILL');
                }
            }, killGraceMs);

            this.ladders.add(kill);
        }, killGraceMs);

        this.ladders.add(term);
    }

    /**
     * At startup nothing is running any more. Engine processes that outlived the daemon are killed (when their pid still
     * belongs to the process that was recorded), and runs that were mid-turn come back `interrupted`. Runs that only
     * wait (queued, blocked, waiting for children) keep waiting; the driver starts them again.
     */
    async recover(): Promise<number> {
        for (const { process: survivor } of listRunsWithProcess(this.store.db)) {
            await killSurvivor(survivor, this.config.timings.killGraceMs);
        }

        return this.store.tx(() => {
            const withProcess = new Set(listRunsWithProcess(this.store.db).map(entry => entry.runId));
            const dead = listActiveRuns(this.store.db).filter(run => ['running', 'waiting_user'].includes(run.status) || withProcess.has(run.id));

            for (const run of dead) {
                setRunWork(this.store.db, run.id, { process: null });
                this.setStatus(run.id, 'interrupted', { reason: 'Daemon restarted' });
            }

            for (const projectId of new Set(dead.map(run => run.projectId))) {
                const count = dead.filter(run => run.projectId === projectId).length;

                this.store.emit(projectId, { type: 'notice', level: 'warn', text: `The daemon restarted; ${ count } ${ count === 1 ? 'run was' : 'runs were' } interrupted` });
            }

            return dead.length;
        });
    }

    /** How many runs are queued, running, waiting or blocked. */
    activeCount(): number {
        return countActiveRuns(this.store.db);
    }

    /* ----------------------------- Session details ----------------------------- */

    setSessionId(runId: string, sessionId: string): void {
        this.update(runId, run => ({ ...run, sessionId }));
    }

    /** Remembers the engine process of a run, for killing it after a cancel or a crash. */
    setProcess(runId: string, engineProcess: RunProcess | null): void {
        setRunWork(this.store.db, runId, { process: engineProcess });
    }

    addUsage(runId: string, usage: RunUsage): void {
        this.update(runId, (run) => {
            const total: RunUsage = {
                inputTokens: (run.usage?.inputTokens ?? 0) + usage.inputTokens,
                outputTokens: (run.usage?.outputTokens ?? 0) + usage.outputTokens,
            };
            const cost = (run.usage?.costUsd ?? 0) + (usage.costUsd ?? 0);

            if (run.usage?.costUsd !== undefined || usage.costUsd !== undefined) {
                total.costUsd = cost;
            }

            return { ...run, usage: total };
        });
    }

    /** Sets the model and level the run's next turn applies (the run's chat changed its choice); `undefined` leaves the engine's own. */
    setChoice(runId: string, choice: { model?: string; effort?: string }): void {
        const current = this.require(runId);

        if (current.model === choice.model && current.effort === choice.effort) {
            return;
        }

        this.update(runId, (run) => {
            const { model: _model, effort: _effort, ...rest } = run;

            return { ...rest, ...(choice.model && { model: choice.model }), ...(choice.effort && { effort: choice.effort }) };
        });
    }

    /**
     * Keeps the latest reading of the session's context window. Agents report it with every message, so a reading is written when it moved by a percent of
     * the window (or the window changed) and, with `settled`, whenever it differs: the turn ended, and the number a person sees is the final one.
     */
    setContext(runId: string, context: RunContext, settled = false): void {
        const current = this.require(runId).context;
        const step = settled ? 1 : context.size / 100;

        if (current?.size === context.size && Math.abs(context.used - current.used) < step) {
            return;
        }

        this.update(runId, run => ({ ...run, context }));
    }

    /** Changes the run's one-line description. */
    describe(runId: string, summary: string): void {
        this.update(runId, run => ({ ...run, summary }));
    }

    private update(runId: string, change: (run: Run) => Run): void {
        this.store.tx(() => {
            const next = change(this.require(runId));

            upsertRun(this.store.db, next);
            this.store.emit(next.projectId, { type: 'run.upserted', run: next });
        });
    }

    /** A line in the stream, such as "Started Executor 02 on CLW-2". */
    note(runId: string, text: string): void {
        appendItem(this.store, runId, { kind: 'note', text });
    }

    projectOf(run: Run): Project {
        const project = getProject(this.store.db, run.projectId);

        if (!project) {
            throw invalid(`Project ${ run.projectId } of run ${ run.id } is gone`);
        }

        return project;
    }
}

function blockedReason(blockers: Task[]): string {
    return `Waiting for ${ blockers.map(task => task.key).join(', ') }`;
}
