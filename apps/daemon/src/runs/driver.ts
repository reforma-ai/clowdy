import { isTerminalRunStatus, mainFolder, STOPPED_TOOL } from '@clowdy/protocol';
import { statSync } from 'node:fs';

import { getChat } from '../db/chats';
import { listItems, nextSeq } from '../db/items';
import { getRun, getRunWork, listActiveRuns, listRunsWithProcess, setRunWork } from '../db/runs';
import { appendItem, markRewindPoint } from '../domain/items';
import { EngineFailure, errorMessage } from '../errors';
import { conversationRecord } from './history';
import { backoffDelay, engineName, formatMoment, parseLimit, sleep } from './limits';
import { NativeAgents } from './native';
import { describeProcess, killSurvivor } from './processes';
import { backgroundEndedMessage, backgroundNote, backgroundStoppedMessage, CONTINUE_MESSAGE, lostBackgroundMessage, skillPrompt, systemPrompt } from './prompts';
import { lastTurnText } from './threads';
import { sessionTitle } from './titles';
import { ASK_USER } from './tools';
import { BACKGROUND_REASON, STOPPED_TO_SEND_REASON } from './transitions';
import { TurnWriter, UNFINISHED_TOOL } from './writer';

import type { BackgroundItem, Chat, ChatMode, EngineId, Project, Run, RunContext } from '@clowdy/protocol';
import type { Config } from '../config';
import type { RunWork } from '../db/runs';
import type { EngineRegistry, EngineSession, ToolDefinition } from '../engine/types';
import type { Store } from '../store';
import type { LimitSignal } from './limits';
import type { PromptChat } from './prompts';
import type { RunService } from './service';

/** A run that fails this many times in a row on passing engine errors (overload, rate limit) is failed for good. */
const MAX_TRANSIENT_FAILURES = 4;

export interface DriverDeps {
    store: Store;
    config: Config;
    runs: RunService;
    engines: EngineRegistry;
    /** The tools a run gets: a chat orchestrator's. */
    tools(run: Run, mode: ChatMode): ToolDefinition[];
    /** The message that makes the engine's agent compact its conversation, or `undefined` for an agent with no such command. */
    compactCommand(engine: EngineId): string | undefined;
    /** Whether the person left the agent's chat titles on, or `undefined` for an agent that has no such switch: a chat of it keeps the first words of its message. */
    namesChats(engine: EngineId): boolean | undefined;
}

interface LiveRun {
    session?: EngineSession;
    engine?: EngineId;
    /** Writes the running turn's stream; a steer the agent took closes its open message. */
    writer?: TurnWriter;
    /** Aborts this turn's session without cancelling the run. */
    turn?: AbortController;
    /** The turn was ended on purpose (`interrupt`): it is not a failure, and the run is left at rest for the message that asked for it. */
    interrupted?: boolean;
    /** Set when the engine is at its subscription limit: the turn stops and the run waits for the reset. */
    pausedUntil?: number;
    native?: NativeAgents;
    /** What the running turn was told, so a retry before the session id is known can say it again. */
    prompt?: string;
    /** The run's own signal (a cancel, a daemon stop): a message delivered to the session waits for its slot under it. */
    signal?: AbortSignal;
    /** What ends the session: the run's signal, the turn's abort, the daemon's stop. */
    ended?: AbortSignal;
    /** Closes the session; asking again waits for the first close. */
    close?: () => Promise<void>;
    /** The latest complete list of what the session has open in the background. */
    background?: BackgroundItem[];
    /** The tool calls that are still running and stand for some of it (a command's call that outlived the turn): the turn's end does not fail them. */
    calls?: string[];
    /** The items the latest lists lost and nothing has confirmed finished yet: one that comes back with the next list is the same item (`settleFinished`). */
    finishing?: Map<string, BackgroundItem>;
    /** The background commands and tasks the person stopped alone this turn (`stopCommand`), by item id: their end is a stop, and the agent was told of it already. */
    stopped?: Map<string, BackgroundItem>;
    /** The session outlived a turn and the run waits for its background work (`waiting_background`): a message goes to the session. */
    lingering?: boolean;
    /** Messages handed to the session that its `done` has not answered yet: the engine sends one `done` for each. */
    sent?: number;
    /** A message is on its way to the lingering session (waiting for a slot, or being handed over): the session must not be settled or steered meanwhile. */
    delivering?: boolean;
    delivery?: Promise<void>;
    /** The session could not take a message: the flight ends it and runs the message as the next turn of a new one, the slot kept. */
    restart?: boolean;
    /** Whether this session counts toward `maxProcesses`: it does not while the run waits for background work. */
    counted?: boolean;
    /**
     * The session's latest `done` went through `turnEnded`: whether background work was still open then, and the stream's last item at that moment, after
     * which a turn the agent starts by itself says its own words.
     */
    told?: { open: boolean; seq: number };
}

/** Why a turn has to be repeated after a wait. */
type Wait = { kind: 'limit'; until: number } | { kind: 'transient'; delayMs: number; message: string };

/**
 * What a turn that did not settle the run asks for: a wait, or at once the next turn of a new session (the old one could not take a message), the slot
 * kept, or the run at rest because its turn was ended on purpose (`interrupt`).
 */
type Retry = Wait | { kind: 'resume' } | { kind: 'stopped' };

/** Synchronous, because a turn reads it between counting the live sessions and starting its own: nothing may wait there. */
export function isFolder(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}

/**
 * The project's folders a turn hands the agent besides the one it works in, in the project's order. A folder that is gone is left out rather than
 * risk an agent that refuses to start on a path that does not exist; `ProjectInfo` reports it missing to the app.
 */
function additionalFolders(project: Project, cwd: string): string[] {
    return project.folders.flatMap(folder => folder.path !== cwd && isFolder(folder.path) ? [folder.path] : []);
}

/**
 * The folder a turn works in: the one the run names (a thread's own `cwd`), else the folder of the project its chat works in (`Chat.folderId`), else the
 * main folder. A chat whose folder the project no longer has was handed back to the main folder when the folder left, so a stale id reads as none.
 */
function workingFolder(project: Project, chat: Chat | undefined, own: string | undefined): string {
    if (own) {
        return own;
    }

    const folder = chat?.folderId === undefined ? undefined : project.folders.find(candidate => candidate.id === chat.folderId);

    return (folder ?? mainFolder(project)).path;
}

/** What the system prompt says about a run's chat: none for a run without one, the parent's id and title for a thread (`Chat.parentChatId`). */
function promptChat(store: Store, chat: Chat | undefined): PromptChat | undefined {
    if (!chat) {
        return undefined;
    }

    const parent = chat.parentChatId ? getChat(store.db, chat.parentChatId) : undefined;

    return chat.parentChatId ? { parent: { id: chat.parentChatId, title: parent?.title ?? chat.parentChatId } } : {};
}

const firstLine = (text: string) => text.split('\n')[0].trim().slice(0, 300);

/**
 * Drives runs: takes a run through its slot, feeds the engine session one turn at a time, maps its events to stream items, and settles the run's
 * status. A session whose agent keeps background work open outlives its turn (`waiting_background`), and a message goes into it; any other turn ends
 * its session, and the next message starts a new turn of the same conversation. Everything durable goes through `RunService` and the stream writer.
 */
export class RunDriver {
    /** Called once a turn's engine session has started, with the run's id: messages steered while the run had no session can go to it now. */
    onTurnStarted: (runId: string) => void = () => undefined;
    /**
     * Called after the commit in which a turn of a chat's orchestrator ended at a `done` and left the run `succeeded` or `waiting_background` (also a turn
     * the agent started by itself while its session waits), with the run as that commit left it and the turn's final text (see `turnEnded`). A Stop, a
     * failure, a turn ended to send a message and a compact turn are not turn ends here, and neither is one with nothing to tell: no text, nothing open,
     * and no earlier word that work was still open.
     */
    onTurnEnd: (run: Run, text: string | undefined) => void = () => undefined;
    private live = new Map<string, LiveRun>();
    /** The last flight of each run. A new one starts behind it, so a run never has two turns at once. */
    private flights = new Map<string, Promise<void>>();
    /** Engine sessions started and not yet closed. */
    private sessions = 0;
    /** Aborted when the daemon stops. A session may run on after its turn (`EngineStartOptions.title`), when its run's own signal is gone. */
    private stopping = new AbortController();

    constructor(private deps: DriverDeps) {
        deps.runs.stopNative = (child, reason) => this.stopSubagent(child, reason);
        deps.runs.stopCommand = (runId, itemId) => this.stopCommand(runId, itemId);
    }

    /* --------------------------------- Starting -------------------------------- */

    /**
     * Starts the next turn of a `queued` or `blocked` run once the surrounding transaction commits. The turn begins with the message stored on the run.
     * A run whose session outlived its turn (it waits for background work) takes the message into that session instead: the flight that reads the session
     * ends only with it, so a new flight queued behind it would never start.
     */
    launch(runId: string): void {
        this.deps.store.afterCommit(() => {
            const waiting = this.live.get(runId);

            // A session that is being shut down (a Stop, a daemon stop) takes nothing: its flight ends it, and the message starts the next flight behind it.
            if (waiting?.lingering && !waiting.ended?.aborted) {
                // A message already on its way is this one: the run was queued once.
                if (!waiting.delivering) {
                    this.deliver(runId, waiting);
                }

                return;
            }

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

        // A message on its way to a session that waited is handed over first: a steer before it would start a turn of its own.
        if (!session?.steer || !writer || live?.delivering || this.deps.runs.require(runId).status !== 'running') {
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
     * Whether the run's live session can take no steer at all (`EngineSession.canSteer`): a steer would be refused however early it came, so a message that
     * has to go now can only go after the turn. A run with no session yet, or whose agent has not said, is not known to be unable: the answer is `false`,
     * and so it is for a turn that is ending already (a Stop, an `interrupt`).
     */
    cannotSteer(runId: string): boolean {
        const live = this.live.get(runId);
        const session = live?.session;

        return session !== undefined && !live?.ended?.aborted && (session.steer === undefined || session.canSteer === false);
    }

    /**
     * Ends the turn the run is working on, on purpose, so that a message the agent cannot take meanwhile (`cannotSteer`) can be the next one: stop and send.
     * The session is aborted as a Stop would, and the run is left at rest (`cancelled`, "Stopped to send a message"; see `rest`) once the turn has wound
     * down, which is when the queue sends the message. It is not a Stop: the run's own signal stays, and nothing holds the queue. Returns whether there was
     * a running turn to end.
     */
    interrupt(runId: string): boolean {
        const live = this.live.get(runId);

        if (!live?.session || !live.turn || live.ended?.aborted || this.deps.runs.require(runId).status !== 'running') {
            return false;
        }

        live.interrupted = true;
        live.turn.abort();

        return true;
    }

    /**
     * Prepares the request that asks the live session of the run that owns the native sub-agent `child` to end it, and only it: the session, the run and
     * the other sub-agents go on (the queue is not paused either). Answers the function that sends it, which the caller runs once its transaction has
     * committed (`RunService.stopAlone`), or `undefined` when the request cannot be made: the owner's session is live and not ending, it can end a
     * sub-agent alone (`EngineSession.stopItem`), and it has this one running. The request is sent and not waited for. The sub-agent's run ends the way
     * every sub-agent's does, through the engine's `subagent` event (`cancelled`, with `reason` as what its run shows), so a sub-agent that finishes on
     * its own meanwhile ends as finished. The agent ends that sub-agent and nothing below it (Claude's adapter leaves the sub-agents of a stopped
     * sub-agent working), so a Stop of one that has sub-agents of its own asks for each of them (`RunService.cancel`).
     */
    stopSubagent(child: Run, reason: string): (() => void) | undefined {
        // The run whose session holds the sub-agent: a sub-agent of a sub-agent hangs from the one that started it, and that one from the session's run.
        let owner: Run | undefined = child;

        while (owner?.origin === 'native' && owner.parentRunId !== undefined) {
            owner = getRun(this.deps.store.db, owner.parentRunId);
        }

        const live = owner && owner !== child ? this.live.get(owner.id) : undefined;
        const { session, native } = live ?? {};
        const stopItem = session?.stopItem?.bind(session);
        const agentId = native?.agentOf(child.id);

        if (!live || !native || !stopItem || agentId === undefined || live.ended?.aborted) {
            return undefined;
        }

        return () => {
            native.stopped(agentId, reason);
            stopItem(agentId).then(
                (sent) => {
                    if (!sent) {
                        console.warn(`[clowdy] the session that holds sub-agent ${ child.id } did not ask its agent to stop it: the sub-agent or the session has ended, or cannot be stopped alone`);
                    }
                },
                error => console.warn(`[clowdy] stopping sub-agent ${ child.id } failed: ${ errorMessage(error) }`)
            );
        };
    }

    /**
     * Prepares the request that asks the live session of the run to end one background command or task alone (`RunService.stopBackground`): the session,
     * the run and everything else it has open go on. Answers the function that sends it, which the caller runs once its transaction has committed, or `undefined`
     * when the request cannot be made: the session is live and not ending, it can end one thing alone (`EngineSession.stopItem`), and the run's latest list
     * has the command with the agent's permission (`canStopAlone`). A repeat for a command already being stopped answers a function that does nothing, so a
     * command is stopped once. The command ends the way every background item does, as a snapshot without it, and its stream note says it was stopped
     * (`settleFinished`). Once the agent took the request, it is told the person stopped the command: a stopped command gives it no report, and the
     * session takes the line as a prompt of its own (`tell`).
     */
    stopCommand(runId: string, itemId: string): (() => void) | undefined {
        const live = this.live.get(runId);
        const session = live?.session;
        const item = live?.background?.find(candidate => candidate.id === itemId);

        if (!live || !session?.stopItem || !item?.canStopAlone || item.kind === 'subagent' || live.ended?.aborted) {
            return undefined;
        }

        if (live.stopped?.has(itemId)) {
            return () => undefined;
        }

        const stopItem = session.stopItem.bind(session);

        return () => {
            live.stopped?.set(itemId, item);
            stopItem(itemId).then(
                (taken) => {
                    if (taken) {
                        // This line, once in flight, keeps `reportEnd` from telling an agent that starts no turn of its own what finished while the command
                        // ran, if the stopped command is the last item to leave (the list can come after the answer to the request): that goes in the same
                        // prompt. When the list came first, `reportEnd` told it already and nothing is left to add.
                        const finished = live.session?.wakesOnBackgroundEnd ? [...(live.finishing?.values() ?? [])].filter(done => !live.stopped?.has(done.id)).map(done => ({ item: done, stopped: false })) : [];

                        this.tell(runId, live, [finished.length > 0 && backgroundEndedMessage(finished), backgroundStoppedMessage(item)].filter(Boolean).join('\n\n'));
                    }
                    else {
                        // It ended on its own, or the agent would not: whatever ends it later is not a stop.
                        live.stopped?.delete(itemId);
                        console.warn(`[clowdy] the agent did not take the request to stop background command ${ itemId } of run ${ runId }: it has ended, or cannot be stopped alone`);
                    }
                },
                (error) => {
                    live.stopped?.delete(itemId);
                    console.warn(`[clowdy] stopping background command ${ itemId } of run ${ runId } failed: ${ errorMessage(error) }`);
                }
            );
        };
    }

    /**
     * Hands the live session a prompt of the runtime's own (a note that background work ended, the line that the person stopped a command): not a message of
     * the person, so nothing is written to the stream for it, and the answer is a turn of its own, written like one the agent started. It counts as a message
     * in flight until the session's `done` answers it, like any `send` (`live.sent`). A session that cannot take it, or that is ending, is left alone.
     */
    private tell(runId: string, live: LiveRun, text: string): void {
        const { session } = live;

        if (!session?.send || live.ended?.aborted) {
            return;
        }

        live.sent = (live.sent ?? 0) + 1;

        const refused = () => {
            live.sent = Math.max(0, (live.sent ?? 0) - 1);
        };

        session.send(text).then(
            (taken) => {
                if (!taken) {
                    refused();
                }
            },
            (error) => {
                refused();
                console.warn(`[clowdy] run ${ runId }'s session refused a note: ${ errorMessage(error) }`);
            }
        );
    }

    /**
     * Whether the run's turn, the one that waits to start or the one in flight, is the agent's compact command (`chat.compact`): asking for another would
     * only compact what is being compacted.
     */
    isCompacting(runId: string): boolean {
        const { engine } = this.deps.runs.require(runId);
        const live = this.live.get(runId);

        return (live?.session !== undefined && this.isCompactCommand(engine, live.prompt)) || this.isCompactCommand(engine, getRunWork(this.deps.store.db, runId).nextPrompt);
    }

    /** Whether `prompt` is the engine's compact command, which a turn must be told alone (`chat.compact`). */
    private isCompactCommand(engine: EngineId, prompt: string | null | undefined): boolean {
        return typeof prompt === 'string' && prompt === this.deps.compactCommand(engine);
    }

    /** Aborts every live run without changing statuses (the next start marks them interrupted) and waits for them to settle. */
    async stop(): Promise<void> {
        const { runs, config, store } = this.deps;

        runs.abortAll();
        this.stopping.abort();
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

        live.signal = signal;

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

                // The slot is held already: the message that the session could not take starts a new one.
                if (retry.kind === 'resume') {
                    continue;
                }

                if (retry.kind === 'stopped') {
                    this.rest(runId);

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

    /**
     * What a session of a chat's orchestrator is opened with, a turn's or a fork's: the folder it works in (`workingFolder`: the run's own, else the folder of
     * its chat, else the project's main one), the project's other folders, the system prompt (`chat` says what the run's chat adds to it) and the tools of the
     * run. `ownChat` is the run's chat, which names the folder. Throws an `EngineFailure` when the folder is gone.
     */
    private surroundings(run: Run, work: RunWork, ownChat: Chat | undefined, chat: PromptChat | undefined) {
        const { runs, config } = this.deps;
        const project = runs.projectOf(run);
        const mode = runs.modeOf(run);
        const cwd = workingFolder(project, ownChat, work.cwd);

        // An engine told to start in a folder that is gone fails with the spawn's own error, which blames the program; say what is wrong.
        if (!isFolder(cwd)) {
            throw new EngineFailure(`The folder ${ cwd } no longer exists`);
        }

        return {
            cwd,
            additionalDirectories: additionalFolders(project, cwd),
            systemPrompt: [systemPrompt(mode, project, cwd, chat), skillPrompt(config.systemSkillsDir, chat?.parent !== undefined)].filter(Boolean).join('\n\n'),
            tools: this.deps.tools(run, mode),
        };
    }

    /**
     * Asks the agent of a chat's orchestrator to copy its session through the rewind point `ref` (`AgentEngine.fork`) and gives the copy's session id. The copy
     * is opened as a turn of that run opens its session (the same folder, other folders, tools, and a system prompt as for a chat that is no thread, which is
     * what the fork's chat will be), because an agent keeps its sessions by folder and a later turn of the copy resumes it there. The run's own session is not
     * touched, so the run may be working. It takes no slot and writes nothing: the caller makes the fork's chat once this answers. Rejects with an
     * `EngineFailure` when the agent cannot fork or the fork fails; the daemon's stop cancels it.
     */
    async forkSession(runId: string, ref: string): Promise<string> {
        const { store, runs, engines } = this.deps;
        const run = runs.require(runId);
        const engine = engines.get(run.engine);

        if (!run.sessionId) {
            throw new EngineFailure('This chat has no conversation to fork yet');
        }

        if (!engine?.fork) {
            throw new EngineFailure(`The ${ run.engine } engine cannot fork a conversation`);
        }

        const ownChat = run.chatId ? getChat(store.db, run.chatId) : undefined;
        const { sessionId } = await engine.fork({
            ...this.surroundings(run, getRunWork(store.db, runId), ownChat, {}),
            sessionId: run.sessionId,
            ref,
            signal: this.stopping.signal,
        });

        return sessionId;
    }

    /**
     * One engine session, from its start until it ends: the turn, and for an orchestrator whose agent still has background work open, the wait after it
     * (`consume`). Returns what to wait for when the turn has to be repeated.
     */
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
        const engine = engines.get(run.engine);

        if (!engine) {
            throw new EngineFailure(`The ${ run.engine } engine is not available in this daemon`);
        }

        // The stream as it is before this turn adds its own lines: what the agent was told so far.
        const told = nextSeq(store.db, runId) - 1;
        const work = getRunWork(store.db, runId);
        const ownChat = run.chatId ? getChat(store.db, run.chatId) : undefined;
        const surroundings = this.surroundings(run, work, ownChat, promptChat(store, ownChat));
        const { prompt, lost } = this.compose(work, run.engine);

        const turnAbort = new AbortController();
        const ended = AbortSignal.any([signal, turnAbort.signal, this.stopping.signal]);
        const writer = new TurnWriter(store, runId);
        const native = new NativeAgents(store, runs, run, () => typeof live.session?.stopItem === 'function');

        live.engine = run.engine;
        live.writer = writer;
        live.turn = turnAbort;
        live.native = native;
        live.prompt = prompt;
        live.ended = ended;
        live.background = undefined;
        live.calls = undefined;
        live.finishing = new Map();
        live.stopped = new Map();
        live.lingering = false;
        live.sent = 0;
        live.delivering = false;
        live.delivery = undefined;
        live.restart = false;
        live.interrupted = false;
        live.told = undefined;

        // The message this turn sends is in the stream already; the record leaves it out, as the agent gets it in the prompt.
        const incoming = [prompt];
        const session = engine.start({
            ...surroundings,
            prompt,
            resumeSessionId: run.sessionId,
            ...(run.sessionId && { history: () => conversationRecord(listItems(store.db, runId, 0).filter(item => item.seq <= told), incoming) }),
            model: run.model,
            effort: run.effort,
            title: sessionTitle(store, run, this.deps.namesChats(run.engine), prompt),
            signal: ended,
        });
        let closing: Promise<void> | undefined;
        // However often it is asked and whoever asks (the end of the turn, a refused message, a Stop of a run that waits), the session is closed once.
        const close = () => closing ??= (async () => {
            try {
                await session.close();
            }
            catch {
                // The session is over either way.
            }
        })();
        // A session that waits for background work is read from an iterator that blocks until the agent says something: a Stop or a daemon stop must not wait for it.
        const onEnded = () => {
            if (live.lingering) {
                void close();
            }
        };

        this.sessions++;
        live.counted = true;
        live.session = session;
        live.close = close;
        ended.addEventListener('abort', onEnded, { once: true });
        store.tx(() => setRunWork(store.db, runId, { nextPrompt: null, ...(lost && { lostBackground: null }) }));
        this.onTurnStarted(runId);

        try {
            const result = await this.consume(run, session, writer, live);

            // A message was on its way to the session when it ended; its refusal (the session is over) makes it the next turn of a new one.
            await live.delivery;

            if (live.restart) {
                return { kind: 'resume' };
            }

            this.settle(runId, live, result);

            return undefined;
        }
        catch (error) {
            await live.delivery;

            if (live.restart && !ended.aborted) {
                return { kind: 'resume' };
            }

            if (live.pausedUntil !== undefined && !signal.aborted) {
                return { kind: 'limit', until: live.pausedUntil };
            }

            // Ended on purpose to send a message (`interrupt`): whatever the engine said on its way out (a process that was told to stop may report an error)
            // is not a failure, and the turn is not repeated. The status is set once the turn has wound down, in `drive`.
            if (live.interrupted && !signal.aborted) {
                return { kind: 'stopped' };
            }

            if (error instanceof EngineFailure && error.retryable && failures < MAX_TRANSIENT_FAILURES && !signal.aborted) {
                runs.limits.transientFailure(run.engine);

                return { kind: 'transient', delayMs: backoffDelay(failures + 1, config.timings.retryBaseMs), message: error.message };
            }

            throw error;
        }
        finally {
            ended.removeEventListener('abort', onEnded);
            // Whatever the agent and its sub-agents left running ends with the session: a Stop or a failure mid-call would otherwise leave the call shimmering.
            const reason = signal.aborted || live.interrupted ? STOPPED_TOOL : UNFINISHED_TOOL;

            writer.finish(reason);
            native.finish(reason);
            live.session = undefined;
            live.writer = undefined;
            live.pausedUntil = undefined;
            live.lingering = false;
            this.forgetBackground(runId, live);
            await close();
            // A session that waited for background work was not counted.
            if (live.counted) {
                this.sessions--;
                live.counted = false;
            }

            runs.setProcess(runId, null);
        }
    }

    /**
     * The turn was ended on purpose (`interrupt`) and has wound down: its message is closed, its calls are stopped and its session is gone. The run rests as
     * `cancelled` with the reason, which is what the chat's queue waits for to send its next message; the queue is not paused (a Stop pauses it). A run that
     * ended some other way meanwhile (a Stop) stays as it is. When the message is not in the queue any more (the person took it back while the turn ended)
     * nothing is sent, and the run stays at rest until the next message.
     */
    private rest(runId: string): void {
        const { store, runs } = this.deps;

        store.tx(() => {
            if (!isTerminalRunStatus(runs.require(runId).status)) {
                runs.setStatus(runId, 'cancelled', { reason: STOPPED_TO_SEND_REASON });
            }
        });
    }

    /**
     * What a turn tells the agent: the message stored on the run, then the background work its session lost (`forgetBackground`, `recover`). A turn with
     * neither is a continuation. Nothing is written: the caller does that once the agent has the message, and clears the record of lost work only when
     * `lost` says it was told.
     */
    private compose(work: RunWork, engine: EngineId) {
        // A compact turn is the command alone: work its session lost is told in the turn after it.
        const compact = this.isCompactCommand(engine, work.nextPrompt);
        const lostItems = compact || !work.lostBackground?.length ? undefined : work.lostBackground;
        const prompt = [work.nextPrompt, lostItems && lostBackgroundMessage(lostItems)].filter(Boolean).join('\n\n') || CONTINUE_MESSAGE;

        return { prompt, lost: lostItems !== undefined };
    }

    /**
     * The session is over, and what its agent still had open in the background ended with it: the run stops showing it, and the next turn tells the agent
     * that it is lost. A session that ended on its own had nothing open, so nothing is said.
     */
    private forgetBackground(runId: string, live: LiveRun): void {
        const { store, runs } = this.deps;
        const lost = live.background;

        live.background = undefined;

        if (lost && lost.length > 0) {
            store.tx(() => {
                setRunWork(store.db, runId, { lostBackground: lost });
                runs.setBackground(runId, []);
            });
        }
    }

    /* ------------------------------ Live-session delivery ----------------------------- */

    /**
     * A message for a run whose session outlived its turn (`runs.resume` put the run back in the queue, and `launch` came here): once the run has a slot
     * the message goes into the live session. Everything stays with the flight that reads the session: this only starts the hand-over.
     */
    private deliver(runId: string, live: LiveRun): void {
        live.delivering = true;
        // The person's message is in the stream already: what the agent says from now on follows it, not the message the agent is in the middle of.
        live.writer?.end();
        live.delivery = this.hand(runId, live)
            .catch((error) => {
                console.error(`[clowdy] handing a message to run ${ runId } failed: ${ errorMessage(error) }`);
                this.refuse(live);
            })
            .finally(() => {
                live.delivering = false;
            });
    }

    private async hand(runId: string, live: LiveRun): Promise<void> {
        const { store, runs } = this.deps;
        const { session, signal } = live;

        if (!session?.send || !signal) {
            this.refuse(live);

            return;
        }

        try {
            await runs.acquireSlot(runId, signal);
        }
        catch (error) {
            // Stopped while it waited for a slot: the flight ends the session. Anything else leaves the message for a new session.
            if (!signal.aborted && !isTerminalRunStatus(runs.require(runId).status)) {
                console.warn(`[clowdy] run ${ runId } did not get a slot for its message: ${ errorMessage(error) }`);
                this.refuse(live);
            }

            return;
        }

        // The session ended while the message waited for its slot: it takes nothing, and the message starts a new one.
        if (!live.lingering) {
            this.refuse(live);

            return;
        }

        const { prompt, lost } = this.compose(getRunWork(store.db, runId), runs.require(runId).engine);

        // The session takes a turn: it counts toward `maxProcesses` again (it is running already, so the cap cannot refuse it). The answer is counted
        // before the message goes, since the agent's events can come back before the call returns.
        this.sessions++;
        live.counted = true;
        live.sent = (live.sent ?? 0) + 1;

        let accepted = false;

        try {
            accepted = await session.send(prompt);
        }
        catch (error) {
            console.warn(`[clowdy] run ${ runId }'s session refused a message: ${ errorMessage(error) }`);
        }

        if (!accepted) {
            live.sent--;
            this.refuse(live);

            return;
        }

        live.prompt = prompt;
        live.delivering = false;
        // The answer to this message is a turn end of its own, whatever the turns before it told.
        live.told = undefined;
        store.tx(() => setRunWork(store.db, runId, { nextPrompt: null, ...(lost && { lostBackground: null }) }));
        this.onTurnStarted(runId);
    }

    /**
     * The live session cannot take the message (it is over, or does not answer): its process ends, so does the background work in it, and the message
     * becomes the next turn of a new session that resumes the conversation, which is told what was lost (`forgetBackground`). The flight does that, with
     * the slot as it is.
     */
    private refuse(live: LiveRun): void {
        live.restart = true;
        live.delivering = false;
        void live.close?.();
    }

    /**
     * Maps the session's events until the run is done with it; returns the final report. A session usually ends at its first `done`. One whose agent has
     * background work open stays, and what it says after that (the work's progress, a turn it starts by itself, the answer to a message `deliver` hands
     * it) is read from the same iterator until it ends.
     */
    private async consume(run: Run, session: EngineSession, writer: TurnWriter, live: LiveRun): Promise<string | undefined> {
        const { runs } = this.deps;
        const native = live.native as NativeAgents;
        let context: RunContext | undefined;
        let result: string | undefined;
        let answered = false;

        try {
            for await (const event of session) {
                switch (event.type) {
                    case 'session':
                        runs.setSessionId(run.id, event.sessionId);
                        writer.heard();
                        break;
                    case 'process':
                        runs.setProcess(run.id, describeProcess({ pid: event.pid, pgid: event.pgid, startedAt: event.startedAt }));
                        break;
                    case 'text':
                        if (event.agentId === undefined) {
                            // Only the agent's words say that what a list lost stayed away: a sub-agent's are its own, and the mark that ends the
                            // agent's open message (the layer ends it when a card is drawn) is no word.
                            if (event.delta !== '') {
                                this.settleFinished(run, live, writer, native);
                            }

                            writer.text(event.delta, event.done, event.messageId);
                        }
                        else {
                            native.stream({ ...event, agentId: event.agentId });
                        }

                        break;
                    case 'thought':
                        if (event.agentId === undefined) {
                            writer.reasoning(event.delta, event.done);
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
                            // The card of a sub-agent's call is bookkeeping of the sub-agent that may have just come back, not something the agent did.
                            if (!native.isCard(event.toolCallId)) {
                                this.settleFinished(run, live, writer, native);
                            }

                            // The call of a command the person stopped ends failed with whatever the agent says about the kill: it was stopped, as a Stop of the run reads.
                            writer.tool(event.state === 'error' && live.stopped?.has(event.toolCallId) ? { ...event, error: STOPPED_TOOL } : event);
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
                    case 'background':
                        this.onBackground(run, live, writer, native, event.items, event.calls);
                        break;
                    case 'done':
                        result = event.result;
                        answered = true;
                        this.settleFinished(run, live, writer, native);

                        // The number shown after a turn is the last one it reported, whatever the throttle skipped on the way.
                        if (context) {
                            runs.setContext(run.id, context, true);
                        }

                        if (!await this.onDone(run, live, session, writer, native, event.result)) {
                            return event.result;
                        }

                        break;
                    case 'error':
                        throw new EngineFailure(event.message, event.retryable, event.code);
                }
            }

            // After an answer the iterator ends when the agent has nothing open any more, or its process is gone. Cut short by a Stop, a daemon stop or a
            // limit, or while an answer is still owed, it is not the end of the work.
            if (answered && !live.sent && !live.ended?.aborted) {
                return result;
            }

            throw new EngineFailure('The engine ended without a result');
        }
        finally {
            // However the turn ended (a result, a failure, a cancel, an engine that threw), the number shown afterwards is the last one it reported,
            // whatever the throttle skipped on the way, and what the last list lost is gone for good.
            if (context) {
                runs.setContext(run.id, context, true);
            }

            this.settleFinished(run, live, writer, native);

            // Nothing more can be handed to a session that is over.
            live.lingering = false;
        }
    }

    /**
     * A `background` snapshot: the run keeps it, and the sub-agents that follow it hear of it. An item that left it is finished only once something else
     * happens (`settleFinished`): a sub-agent that stops and is woken at once by a command of its own is out of the list and back in it within a
     * millisecond, and that is the same item, not one that finished twice. Two things do not wait for the agent to do something: a command the person
     * stopped, which nothing can bring back, and, for an agent that starts no turn to report work that ended, the last item leaving (`reportEnd`).
     */
    private onBackground(run: Run, live: LiveRun, writer: TurnWriter, native: NativeAgents, items: BackgroundItem[], calls?: string[]): void {
        const { store, runs } = this.deps;
        const finishing = live.finishing ?? new Map<string, BackgroundItem>();

        for (const known of live.background ?? []) {
            if (!items.some(item => item.id === known.id)) {
                finishing.set(known.id, known);
            }
        }

        for (const item of items) {
            finishing.delete(item.id);
        }

        live.finishing = finishing;
        live.background = items;
        live.calls = calls;
        native.background(items);
        store.tx(() => runs.setBackground(run.id, items));
        this.reportEnd(run, live, writer, native, items);
    }

    /**
     * What the items that just left the list ask of the runtime before the agent does anything. Commands the person stopped are over for good, so the stream
     * says so now. For an agent that starts no turn of its own to report work that ended (`EngineSession.wakesOnBackgroundEnd`), the last item leaving while the
     * session is idle is the moment nothing else will come: the stream notes are written and the agent gets one note through `send`, so it reports in a turn
     * of that note's own. Not while a turn runs or a message of ours is on its way, not after a Stop, and not for what the person stopped alone: the agent
     * heard of that when the person did it.
     */
    private reportEnd(run: Run, live: LiveRun, writer: TurnWriter, native: NativeAgents, items: BackgroundItem[]): void {
        const lost = [...(live.finishing?.values() ?? [])];

        if (lost.length === 0) {
            return;
        }

        if (lost.every(item => live.stopped?.has(item.id))) {
            this.settleFinished(run, live, writer, native);

            return;
        }

        if (items.length > 0 || !live.session?.wakesOnBackgroundEnd || !live.lingering || live.sent || live.delivering || live.ended?.aborted) {
            return;
        }

        if (this.deps.runs.require(run.id).status !== 'waiting_background') {
            return;
        }

        const told = this.settleFinished(run, live, writer, native).filter(({ item, stopped }) => !stopped || item.kind === 'subagent');

        if (told.length > 0) {
            this.tell(run.id, live, backgroundEndedMessage(told));
        }
    }

    /**
     * What a snapshot lost stayed away, because the agent did something after it (an answer, a call of its own, the end of the turn or of the session):
     * a note names each item, after what the agent said so far, and the sub-agents of those items end. What the agent says next is a new message. What a
     * sub-agent says or does is not that: it is the item that may come back. Gives the items it wrote a note for, and whether the person stopped each.
     */
    private settleFinished(run: Run, live: LiveRun, writer: TurnWriter, native: NativeAgents): { item: BackgroundItem; stopped: boolean }[] {
        const { store, runs } = this.deps;
        const finished = [...(live.finishing?.values() ?? [])];

        if (finished.length === 0) {
            return [];
        }

        live.finishing?.clear();
        native.settle();

        return store.tx(() => {
            writer.end();

            return finished.map((item) => {
                // An item that the person stopped did not finish.
                const stopped = live.stopped?.has(item.id) === true || (item.kind === 'subagent' && native.wasStopped(item));

                runs.note(run.id, backgroundNote(item, stopped));

                return { item, stopped };
            });
        });
    }

    /**
     * A `done`. Returns whether the session stays open for the background work its agent still has, which the iterator goes on being read for; `false` ends
     * it, and the run settles as the turn's result decides. A turn the agent started by itself (the session waits, and no message of ours is out) ends
     * with its own `done` and leaves the run waiting as it was; the answer to a message sent into the session, like the session's first turn, is what
     * decides between waiting on and settling.
     */
    private async onDone(run: Run, live: LiveRun, session: EngineSession, writer: TurnWriter, native: NativeAgents, result: string | undefined): Promise<boolean> {
        writer.end();
        this.markPoint(run, live, writer);

        if (live.lingering && !live.sent) {
            writer.finish(undefined, this.openTasks(live));
            native.finish(undefined, true);

            // The run waits on as it was, and the turn has ended all the same; a Stop that ended the run meanwhile made it no turn end.
            const current = this.deps.runs.require(run.id);

            if (current.status === 'waiting_background') {
                this.turnEnded(current, live, result);
            }

            return true;
        }

        if (live.sent) {
            live.sent--;
            // The agent can answer before the hand-over has written down that it has the message: settling comes after.
            await live.delivery;
        }

        // Only a chat's orchestrator waits; a run with no chat ends its session here, as does an agent that cannot take another prompt.
        const waits = run.role === 'orchestrator' && run.chatId !== undefined && !live.ended?.aborted
            && typeof session.send === 'function' && (live.background?.length ?? 0) > 0;

        if (!waits) {
            return false;
        }

        // Set before the status changes: the commit's callbacks (the chat's queue hands the next message over) already find a session that takes it.
        live.lingering = true;

        if (live.counted) {
            this.sessions--;
            live.counted = false;
        }

        if (!this.settle(run.id, live, result, true)) {
            live.lingering = false;

            return false;
        }

        writer.finish(undefined, this.openTasks(live));

        return true;
    }

    /**
     * A turn ended at a `done`: its final message, when it ended the turn and the agent gave an id for it, becomes the turn's rewind point (`markRewindPoint`),
     * which is what the session can be cut at. Every turn end gets its own, a turn the agent started by itself included; a failed or stopped turn never reaches
     * here, so it has none. The agent's compact command is no turn of the conversation: what it says is a report, and the session after it is not the one
     * the point was said in.
     */
    private markPoint(run: Run, live: LiveRun, writer: TurnWriter): void {
        const point = writer.takePoint();

        if (point && !this.isCompactCommand(run.engine, live.prompt)) {
            markRewindPoint(this.deps.store, run.id, point.seq, point.ref);
        }
    }

    /**
     * The calls of the turn that are background work the session waits for (a `Workflow`, the call that started a sub-agent that goes on, the call of a
     * command that outlived the turn when the agent keeps it running): they run on after the turn, so the turn's end does not fail them.
     */
    private openTasks(live: LiveRun): ReadonlySet<string> {
        return new Set([...(live.background ?? []).filter(item => item.kind === 'task').map(item => item.id), ...(live.calls ?? []), ...(live.native?.openCalls() ?? [])]);
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
    private async waitToRetry(runId: string, live: LiveRun, retry: Wait, signal: AbortSignal): Promise<void> {
        const { store, runs } = this.deps;
        const run = runs.require(runId);
        const now = runs.limits.now();

        // A compact turn is its command and nothing else (`chat.compact`); nothing was compacted, so a "continue" would have the agent resume work that does not exist.
        const compacting = this.isCompactCommand(run.engine, live.prompt);

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
     * The turn ended normally: the run succeeds with the turn's result, unless `lingers`: the agent still has background work open and its session stays,
     * so the run waits in `waiting_background` and keeps the sub-agents that the work includes. Returns whether the run waits with its session open.
     */
    private settle(runId: string, live: LiveRun, result: string | undefined, lingers = false): boolean {
        const { store, runs } = this.deps;

        return store.tx(() => {
            live.native?.finish(undefined, lingers);

            if (isTerminalRunStatus(runs.require(runId).status)) {
                return false;
            }

            if (lingers) {
                this.turnEnded(runs.setStatus(runId, 'waiting_background', { reason: BACKGROUND_REASON }), live, result);

                return true;
            }

            const { told } = live;
            const run = runs.setStatus(runId, 'succeeded', { result });

            // A session that ends after a `done` that was told already (it waited for background work) is no new turn end. It is told once more only when
            // that `done` left work open, so the parent learns that no report is coming.
            if (!told || told.open) {
                this.turnEnded(run, live, result);
            }

            return false;
        });
    }

    /**
     * A turn of `run` ended at a `done` (`settle`, or `onDone` for a turn the agent started by itself): `onTurnEnd` hears of it once the transaction
     * commits, with the turn's final text: the engine's result, else the turn's last message (`lastTurnText`, after the turn told before it in this
     * session: a turn the agent started answers no message), read now, before the chat's queue can give the run its next message. A turn that says nothing
     * and leaves nothing open has nothing to tell, unless the turn told before it left work open: the thread is done then, with no report. The agent's
     * compact command only compacted the context: it is not told.
     */
    private turnEnded(run: Run, live: LiveRun, result: string | undefined): void {
        const { store } = this.deps;

        if (this.isCompactCommand(run.engine, live.prompt)) {
            return;
        }

        const open = run.status === 'waiting_background' && (run.background?.length ?? 0) > 0;
        const text = result?.trim() || lastTurnText(store.db, run.id, live.told?.seq);
        const tells = text !== undefined || open || live.told?.open === true;

        live.told = { open, seq: nextSeq(store.db, run.id) - 1 };

        if (tells) {
            store.afterCommit(() => this.onTurnEnd(run, text));
        }
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
