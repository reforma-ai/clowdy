import { ACTIVE_RUN_STATUSES, isTerminalRunStatus, projectEngine, STOPPED_TOOL } from '@clowdy/protocol';

import { getChat } from '../db/chats';
import { findQuestion, listOpenThoughts, listRunningTools } from '../db/items';
import { getProject } from '../db/projects';
import { activeSubtree, countActiveRuns, countRunsWithRole, getRun, getRunWork, linksOfRun, linksOfTask, listActiveRuns, listEnginePauses, listRunsWithProcess, saveEnginePause, setRunWork, upsertRun } from '../db/runs';
import { getTask } from '../db/tasks';
import { appendItem, updateItem } from '../domain/items';
import { categoryOf, linkRunTask, moveTask, requireTask } from '../domain/tasks';
import { conflict, invalid, notFound, unavailable } from '../errors';
import { newId } from '../ids';
import { EngineLimits } from './limits';
import { killSurvivor, signalProcess } from './processes';
import { QUEUE_REASON, Scheduler } from './scheduler';
import { canTransition, NEEDS_REASON, STOPPED_TO_SEND_REASON } from './transitions';

import type { BackgroundItem, ChatMode, EngineId, Project, QuestionOption, Run, RunContext, RunStatus, RunUsage, Task } from '@clowdy/protocol';
import type { Config } from '../config';
import type { RunProcess } from '../db/runs';
import type { EngineRegistry } from '../engine/types';
import type { Store } from '../store';

const CANCEL_REASON = 'Cancelled by user';

/** Committed events that can change what a waiting run is waiting for. */
const RELEVANT_EVENTS = new Set(['run.upserted', 'task.upserted', 'task.deleted', 'link.runTask']);

/** A run the driver drives: a chat's orchestrator. A native sub-agent is made by `createNative`. */
export interface NewRun {
    project: Project;
    role: 'orchestrator';
    summary: string;
    chatId?: string;
    engine?: EngineId;
    model?: string;
    /** The reasoning level, in the engine's own spelling. */
    effort?: string;
    /** Where the engine works; absent, the folder its chat works in, else the project's main folder (`workingFolder` in `runs/driver.ts`). */
    cwd?: string;
    /** What the run's first turn is told. */
    nextPrompt?: string;
    /** Tasks the run executes. Unfinished dependencies of these tasks block the run. */
    assigned?: Task[];
}

export interface StatusOptions {
    reason?: string;
    result?: string;
    error?: string;
    /** Why a failed run failed, as the engine classed it (`Run.failureCode`). */
    failureCode?: string;
}

const isActive = (status: RunStatus) => ACTIVE_RUN_STATUSES.includes(status);

/** Everything about a run's life that is not the engine conversation: creation, the status machine, slots, waiting, cancelling. */
export class RunService {
    readonly limits: EngineLimits;
    /** Called after the commit in which a chat's orchestrator changed status, with the run as it is now. */
    onOrchestratorStatus: (run: Run) => void = () => undefined;
    /**
     * Prepares the request that asks the live session which owns the native sub-agent `run` to end it alone (the driver sets it), with the reason its run
     * will show. Answers the function that sends it, or `undefined` when the request cannot be made: the session is not live, cannot end that sub-agent, or
     * has not got it open. It sends nothing itself: the caller sends once its transaction has committed (`stopAlone`), because the agent hears of it and a
     * rollback cannot take that back. The sub-agent's run ends later, through the engine's own `subagent` event, not here.
     */
    stopNative: (run: Run, reason: string) => (() => void) | undefined = () => undefined;
    /**
     * Prepares the request that asks the live session of the run `runId` to end its background command `itemId` alone (the driver sets it). Answers the
     * function that sends it, or `undefined` when the request cannot be made (the session is not live, cannot end that command, or has not got it open).
     * It sends nothing itself: the caller sends once its transaction has committed (`stopBackground`), as for a sub-agent.
     */
    stopCommand: (runId: string, itemId: string) => (() => void) | undefined = () => undefined;
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
        const engine = preferred ?? projectEngine(project.settings) ?? this.config.engine;

        if (!this.engines.has(engine)) {
            throw unavailable(`The ${ engine } engine is not available in this daemon`);
        }

        return engine;
    }

    /** Inserts a root run, `queued` or `blocked`, with its task links. The caller launches it. */
    createRun(input: NewRun): Run {
        return this.store.tx(() => {
            const { project } = input;
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
                rootRunId: id,
                ...(input.chatId && { chatId: input.chatId }),
                role: input.role,
                name: `Orchestrator ${ String(number).padStart(2, '0') }`,
                summary: input.summary,
                status: blockers.length > 0 ? 'blocked' : 'queued',
                statusReason: blockers.length > 0 ? blockedReason(blockers) : QUEUE_REASON,
                engine,
                ...(model && { model }),
                ...(input.effort && { effort: input.effort }),
                createdAt: Date.now(),
            };

            upsertRun(this.store.db, run);
            setRunWork(this.store.db, id, { cwd: input.cwd, nextPrompt: input.nextPrompt });
            this.store.emit(project.id, { type: 'run.upserted', run });

            for (const task of assigned) {
                linkRunTask(this.store, project.id, { runId: id, taskId: task.id, relation: 'assigned' });
            }

            return run;
        });
    }

    /**
     * A sub-agent inside `parent`'s engine session, shown as a child run. It starts `running` without a slot: the
     * parent's process does its work. It ends with the parent's turn at the latest. `parentToolCallId` is the parent's call that started it, when
     * the engine said, so the parent's stream can draw that call as the child's card. `canStopAlone` says the session can end it alone, which the app
     * reads to offer a Stop for it (`Run.canStopAlone`).
     */
    createNative(parent: Run, input: { name: string; summary: string; parentToolCallId?: string; canStopAlone?: boolean }): Run {
        return this.store.tx(() => {
            const id = newId('run');
            const run: Run = {
                id,
                projectId: parent.projectId,
                parentRunId: parent.id,
                rootRunId: parent.rootRunId,
                role: 'executor',
                origin: 'native',
                ...(input.parentToolCallId && { parentToolCallId: input.parentToolCallId }),
                ...(input.canStopAlone && { canStopAlone: true }),
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
                // A run that ended has nothing open: its session is gone, and so is what it had running in the background.
                delete next.background;

                if (options.result !== undefined) {
                    next.result = options.result;
                }

                if (options.error !== undefined) {
                    next.error = options.error;
                }

                if (options.failureCode !== undefined) {
                    next.failureCode = options.failureCode;
                }
            }
            else if (isTerminalRunStatus(run.status)) {
                delete next.finishedAt;
                delete next.result;
                delete next.error;
                delete next.failureCode;
            }

            upsertRun(this.store.db, next);
            this.store.emit(run.projectId, { type: 'run.upserted', run: next });
            this.syncTasks(run.status, next);

            if (run.origin !== 'native' && (run.status === 'running' || status === 'queued')) {
                this.store.afterCommit(() => this.scheduler.tick());
            }

            // Only a chat's orchestrator has a chat of its own, and with it the queue of what the person wrote while it worked.
            if (run.chatId) {
                this.store.afterCommit(() => this.onOrchestratorStatus(next));
            }

            return next;
        });
    }

    /** Puts a finished or waiting run back in the queue for its next turn, with the message that starts it (none continues the conversation). */
    resume(runId: string, prompt?: string): Run {
        return this.store.tx(() => {
            setRunWork(this.store.db, runId, { nextPrompt: prompt ?? null });

            return this.setStatus(runId, 'queued');
        });
    }

    /**
     * Task columns follow the work: started runs move tasks to active, a finished run to review, a dead one back to todo. A run that only rests between a
     * turn stopped to send a message and the turn that sends it (`STOPPED_TO_SEND_REASON`) is not dead: its task stays where it is.
     */
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
            else if (['failed', 'cancelled', 'interrupted'].includes(run.status) && category === 'active' && run.statusReason !== STOPPED_TO_SEND_REASON && this.activeRunsOfTask(task.id, run.id).length === 0) {
                moveTask(this.store, task.id, 'todo');
            }
        }
    }

    /** Active runs assigned to the task (a chat started from it), optionally leaving one out. */
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

    /** Resolves after the next commit that can change run or task state. */
    private nextChange(signal: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            const stop = () => {
                unsubscribe();
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

    /* -------------------------------- Questions -------------------------------- */

    /**
     * Puts a question card into the run's stream, parks the run in `waiting_user` until `answerQuestion` delivers
     * the user's reply, then takes a slot again. Returns the reply.
     */
    async ask(runId: string, question: { text: string; options: QuestionOption[]; recommended?: string }, signal: AbortSignal): Promise<string> {
        if (this.asking.has(runId)) {
            throw new Error('Another question is waiting for the user. Ask one question at a time and wait for its answer.');
        }

        // A turn the agent starts by itself while the run waits has no way to park the run for an answer (`waiting_background` does not lead to `waiting_user`).
        if (this.require(runId).status === 'waiting_background') {
            throw new Error('Can\'t ask a question while the run waits for background work');
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
     * a run that is already finished cancels nothing. A sub-agent inside a session is stopped alone when its session can end it (`stopNative`): the
     * answer is its id (and those of the sub-agents it started, which the agent does not end with it), but the runs end a moment later, through the engine's
     * own events, and with what the agent says (one may have finished meanwhile); its parent and the other sub-agents go on. When the session cannot, only the parent's cancel ends it, and this is refused.
     */
    cancel(runId: string, reason = CANCEL_REASON): string[] {
        return this.store.tx(() => {
            const run = this.require(runId);

            if (run.origin === 'native' && isActive(run.status)) {
                if (!this.stopAlone(run, reason)) {
                    throw conflict('A sub-agent runs inside its parent run; cancel the parent run instead');
                }

                // Claude's adapter ends that sub-agent and leaves the ones it started working, so each of them is asked too: the Stop is of the whole branch.
                const below = activeSubtree(this.store.db, runId).filter(id => id !== runId && this.stopAlone(this.require(id), reason));

                return [runId, ...below];
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
     * Stops the sub-agents below `runId` and leaves `runId` itself going on, in one step: every sub-agent inside the session that can be stopped alone
     * (`Run.canStopAlone`) is asked to stop. A sub-agent that cannot be stopped alone is left (only its parent's cancel ends it). Returns the ids it asked
     * to stop, the deepest first. The run is not cancelled and a chat's queue is not held: the agent hears what happened from what the engine says of its
     * sub-agents (Claude Code tells its parent itself) and goes on. Everything is decided in one transaction, so no sub-agent starts or ends between the
     * choice and the request.
     */
    stopAgents(runId: string, reason = CANCEL_REASON): string[] {
        return this.store.tx(() => {
            this.require(runId);

            // Each sub-agent is asked once, the ones a sub-agent started first (`activeSubtree` is the deepest first): the agent ends only the one it is asked
            // about, so nothing is stopped twice.
            return activeSubtree(this.store.db, runId)
                .filter(id => id !== runId)
                .map(id => this.require(id))
                .filter(run => run.origin === 'native' && this.stopAlone(run, reason))
                .map(run => run.id);
        });
    }

    /**
     * Stops one background command of the orchestrator `runId` and nothing else: the run goes on, its other work too, and its chat's queue is not held. The
     * item is the one the run lists with the agent's permission to end it alone (`BackgroundItem.canStopAlone`) and the run's session is live and has it
     * open; the request to the agent goes out once the transaction commits, so a rollback asks nothing of it, and the command's end comes back as the
     * engine's own snapshot without it. Answers whether a request is made or already on its way for that command, so a repeated press is one request and
     * answers the same; `false` for an item that is gone, cannot be stopped alone, or has no live session.
     */
    stopBackground(runId: string, itemId: string): boolean {
        return this.store.tx(() => {
            const run = this.require(runId);
            const item = run.background?.find(candidate => candidate.id === itemId);

            if (!isActive(run.status) || !item?.canStopAlone || item.kind === 'subagent') {
                return false;
            }

            const send = this.stopCommand(runId, itemId);

            if (send) {
                this.store.afterCommit(send);
            }

            return send !== undefined;
        });
    }

    /**
     * Asks the session to end the native sub-agent `run` alone, and answers whether it will: the run is active and was made stoppable, and its session is
     * live and has it open. The request goes out once the transaction commits (like the abort of a cancelled run), so a Stop that rolls back asks nothing of
     * the agent, and each call is one request.
     */
    private stopAlone(run: Run, reason: string): boolean {
        const send = run.canStopAlone && isActive(run.status) ? this.stopNative(run, reason) : undefined;

        if (send) {
            this.store.afterCommit(send);
        }

        return send !== undefined;
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
     * belongs to the process that was recorded), and runs that were mid-turn come back `interrupted`, the calls their turn left running failed as
     * `TurnWriter.finish` would have done (a crash never got to it). A run that waits for background work (`waiting_background`) has a live session
     * too, which no restart keeps, so it is interrupted whether or not a process was recorded for it, and the items it had open are kept in its work
     * record until its next message tells the agent they are lost. Runs that only wait (queued, blocked) keep waiting; the driver starts them again.
     */
    async recover(): Promise<number> {
        for (const { process: survivor } of listRunsWithProcess(this.store.db)) {
            await killSurvivor(survivor, this.config.timings.killGraceMs);
        }

        return this.store.tx(() => {
            const withProcess = new Set(listRunsWithProcess(this.store.db).map(entry => entry.runId));
            const dead = listActiveRuns(this.store.db).filter(run => ['running', 'waiting_user', 'waiting_background'].includes(run.status) || withProcess.has(run.id));

            for (const run of dead) {
                // `setStatus` clears what a run had open in the background, since a run that ended has nothing open; what the restart cost it is kept first,
                // for the next turn's message (`lostBackgroundMessage`).
                setRunWork(this.store.db, run.id, { process: null, lostBackground: run.background });
                this.setStatus(run.id, 'interrupted', { reason: 'Daemon restarted' });

                for (const { seq, body } of listRunningTools(this.store.db, run.id)) {
                    if (body.kind === 'tool') {
                        updateItem(this.store, run.id, seq, { ...body, state: 'error', error: STOPPED_TOOL });
                    }
                }

                // A thought the crash cut short is over: the app shows an open one as still going.
                for (const { seq, body } of listOpenThoughts(this.store.db, run.id)) {
                    if (body.kind === 'reasoning') {
                        updateItem(this.store, run.id, seq, { ...body, done: true });
                    }
                }
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

    /**
     * Takes a chat's orchestrator, at rest, back to the conversation as it stands after an edit of a message cut its stream: `sessionId` is the agent's copy of
     * the session cut at the point before the edited message, and none for the first message of the chat, whose turn starts a fresh session. What the
     * dropped part left on the run is forgotten: the reading of the context window, what its session had lost in the background, a message not sent yet.
     * Usage stays (it is what was spent). The result and the error are cleared by the turn that follows (`resume`).
     */
    rewind(runId: string, sessionId: string | undefined): void {
        this.store.tx(() => {
            this.update(runId, (run) => {
                const { sessionId: _session, context: _context, ...rest } = run;

                return sessionId ? { ...rest, sessionId } : rest;
            });
            setRunWork(this.store.db, runId, { nextPrompt: null, lostBackground: null });
        });
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

    /**
     * Keeps what the agent has open in the background, as the engine's latest complete list (a `background` event repeats the whole list whenever it
     * changes). Nothing is written when the list is the same, and an empty one clears it. A run that ended keeps none: `setStatus` cleared it, and
     * what its session still reports while it shuts down is not open any more.
     */
    setBackground(runId: string, items: BackgroundItem[]): void {
        // Only the protocol's fields are kept, so whatever else an engine put on an item does not reach the row or the clients. The list and each title
        // are bounded: a command's title may be a whole script, and the list rides in every `run.upserted` that the event log keeps.
        const kept = items.slice(0, MAX_BACKGROUND_ITEMS).map(({ id, kind, title, canStopAlone }) => ({ id, kind, title: title.slice(0, MAX_BACKGROUND_TITLE), ...(canStopAlone === true && { canStopAlone: true as const }) }));
        const run = this.require(runId);

        if (isTerminalRunStatus(run.status) || sameItems(run.background ?? [], kept)) {
            return;
        }

        this.update(runId, (run) => {
            const { background: _background, ...rest } = run;

            return kept.length > 0 ? { ...rest, background: kept } : rest;
        });
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

    /** A line in the stream, such as "Background command finished: bun test". */
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

/** The most background items a run keeps, and the longest title of one. */
const MAX_BACKGROUND_ITEMS = 50;
const MAX_BACKGROUND_TITLE = 200;

function sameItems(a: BackgroundItem[], b: BackgroundItem[]): boolean {
    return a.length === b.length && a.every((item, index) => item.id === b[index].id && item.kind === b[index].kind && item.title === b[index].title && item.canStopAlone === b[index].canStopAlone);
}

function blockedReason(blockers: Task[]): string {
    return `Waiting for ${ blockers.map(task => task.key).join(', ') }`;
}
