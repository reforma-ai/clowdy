import { client, ContentBlock, IdleStateUpdate, methods, ndJsonStream, PROTOCOL_VERSION, RequestError, SessionConfigOption, SessionUpdate, StateUpdate } from '@agentclientprotocol/sdk/experimental/v2/unstable';
import { Readable, Writable } from 'node:stream';

import { EngineFailure, errorMessage } from '../../errors';
import { answeredInTime, Channel, ProcessEnded, watchEnd } from './connection';
import { advertisesSteering, applyChoices, isResumeWarning, keepTitle, prefaceOf, STEER_METHOD, steerByExtension, steerRequest, stopFailure } from './conversation';
import { classifyThrown, failureEvent, processEnded } from './failure';
import { BACKGROUND_HANDOFF_MS, BACKGROUND_REPORT_MS } from './layer';
import { UpdateMapperV2 } from './mapper-v2';
import { paramsOfV2 } from './permission';
import { Turns } from './turns';

import type { BackgroundWork, ClientCapabilities, ClientConnection, NewSessionRequest, SessionCapabilities } from '@agentclientprotocol/sdk/experimental/v2/unstable';
import type { BackgroundItem } from '@clowdy/protocol';
import type { EngineEvent, EngineFork } from '../types';
import type { AgentProtocol } from './catalog';
import type { SelectOption, SteerRequest, SteerResponse } from './conversation';
import type { LayerHost, ProtocolLayer } from './layer';
import type { Tokens } from './mapper-core';
import type { ResolvedAgent } from './registry';

/**
 * What the client tells an agent it can do in `initialize`: nothing. Clowdy offers no file access and no terminal (ACP v2 has neither; an agent's tools
 * are its own, and the runtime's reach it through an MCP server).
 */
const clientCapabilities = (agent: Pick<ResolvedAgent, 'clientMeta'>): ClientCapabilities => ({ ...(agent.clientMeta && { _meta: agent.clientMeta }) });

/**
 * What a session of this run is opened with, as the agent's capabilities allow: the working folder, the MCP server of the runtime's tools, the project's other
 * folders, the options its adapter reads, and the system prompt. A resume and a fork send the same.
 */
function sessionRequest({ agent, options, openBridge }: Pick<LayerHost, 'agent' | 'options' | 'openBridge'>, capabilities: SessionCapabilities): NewSessionRequest {
    const access = openBridge();
    // Only an agent that advertises the field gets it, as in v1; the list may differ on a resume while `cwd` stays.
    const directories = capabilities.additionalDirectories ? options.additionalDirectories ?? [] : [];

    return {
        cwd: options.cwd,
        mcpServers: access?.server ? [{ type: 'stdio', ...access.server }] : [],
        ...(directories.length > 0 && { additionalDirectories: directories }),
        ...(agent.sessionMeta && { _meta: agent.sessionMeta }),
        ...(capabilities.systemPrompt && options.systemPrompt && { systemPrompt: { mode: 'append', content: [{ type: 'text', text: options.systemPrompt }] } }),
    };
}

/** How long a fork may take before it is given up: the adapter copies a transcript, which a long conversation makes slow. */
const FORK_TIMEOUT_MS = 120_000;

/** The timers of a session that lives on: the handoff guard before it ends, and the wait for the turn that a message which landed in a turn may have to come. */
type Wake = 'handoff' | 'release';

type Item =
    /** An update of the session the engine talks to, or, with `from`, of a sub-agent's session. */
    | { kind: 'update'; update: SessionUpdate; from?: string }
    | { kind: 'failed'; error: unknown }
    | { kind: 'exited' }
    | { kind: 'aborted' }
    | { kind: 'timer'; which: Wake; id: number }
    /** The time a tool call named has come (`Monitor`, `ScheduleWakeup`: see `timed.ts`): the session is held for it no more. */
    | { kind: 'deadline'; toolCallId: string }
    /** A message on its way to the agent was taken or refused: what the loop waits for may have changed. */
    | { kind: 'nudge' };

/** Where the conversation stands, which the loop reads and moves. */
interface Course {
    /** A turn is in progress: the agent said `running` or `requires_action` since its last `idle`. */
    working: boolean;
    /** A turn ended and its `done` waits: a message that landed in it has a turn of its own to come, or one the agent has not begun queues behind it. */
    held: boolean;
    /** A `done` has been said: from then on the session may be wound up when nothing is open. */
    delivered: boolean;
    /** The last background work ended while no turn ran, and no turn has begun since: the agent owes the report of it, which begins only when its first output arrives. */
    owed: boolean;
    /** What the turns of the activity under way used, summed: it goes out once, in front of their `done`. */
    tokens?: Tokens;
    /** The background work as the runtime was last told. */
    items: BackgroundItem[];
    /** The running tool calls that stand for some of it, as the runtime was last told. */
    calls: string[];
    /** The agent's own list behind `items`. */
    listed: BackgroundWork[];
    /** The calls whose time came while a turn was in flight: they leave `items` once none is (`expire`), so the session is not wound up under a turn. */
    lapsed: Set<string>;
}

/** Adds the tokens a turn used to those of the turns before it in the same activity. */
function summed(total: Tokens | undefined, more: Tokens | null | undefined): Tokens | undefined {
    if (!more) {
        return total;
    }

    const add = (key: keyof Tokens) => (total?.[key] ?? 0) + (more[key] ?? 0);

    return { inputTokens: add('inputTokens'), outputTokens: add('outputTokens'), cachedReadTokens: add('cachedReadTokens'), cachedWriteTokens: add('cachedWriteTokens') };
}

/** The select options among an agent's, each with its choices (the members of its groups included) in one list. */
function selectsOf(options: SessionConfigOption[] | null | undefined): SelectOption[] {
    return (options ?? []).flatMap(option => SessionConfigOption.isSelect(option)
        ? [{ id: option.configId, category: option.category, currentValue: option.currentValue, choices: option.options.flatMap(choice => 'groupId' in choice ? choice.options : [choice]) }]
        : []);
}

/** JSON-RPC's "invalid params" code, which `terminal/cancel` answers for a terminal that is unknown, has exited or cannot be cancelled. */
const INVALID_PARAMS = -32602;

/** ACP's "authentication required" JSON-RPC code: an agent that wants a sign-in has not refused the protocol. */
const AUTH_REQUIRED = -32000;

/**
 * Whether a failed `initialize` is the agent's answer, which says it does not speak v2: an error response, or a result that is no v2 one (a v1 agent
 * answers with `agentCapabilities` and no `info`, which the SDK reports as a validation error). Not the loss of the connection, a program that
 * exited, nor silence (a crash or a slow start is no reason to try another protocol), nor a request to sign in.
 */
const answeredNo = (error: unknown): boolean => error instanceof RequestError ? error.code !== AUTH_REQUIRED : error instanceof Error && error.name === 'ZodError';

/** Whether `update` is the warning Codex gives when it resumes a session recorded with another model (see `isResumeWarning`). */
function isResumeWarningUpdate(update: SessionUpdate): boolean {
    const block = SessionUpdate.isAgentMessageChunk(update) ? update.content : SessionUpdate.isAgentMessage(update) ? update.content?.[0] : undefined;

    return block !== undefined && ContentBlock.isText(block) && isResumeWarning(block.text);
}

/**
 * ACP version 2 (the draft): `initialize` with `info` and `capabilities`, `session/new` or `session/resume`, and a `session/prompt` that only says the
 * message was inserted (`{ messageId }`). The turn is told by `state_update`: `running` while the agent works, `requires_action` while it waits for a
 * person, `idle` with a `stopReason` (and the turn's `usage`) when it is over. A prompt sent while a turn runs is inserted into it, which is how a
 * steer goes in. The SDK's v2 `client()` carries it. See `mapper-v2.ts` for the updates.
 *
 * A sub-agent is a session of its own: its parent announces it with `subagent_update` and what it says comes on its session, which the layer reads
 * from then on, in the order the agent said things (the sessions share one stream), and gives the mapper with the child's id (`mapper-v2.ts`,
 * `children.ts`). An update of any other session is not ours and is dropped.
 *
 * The conversation does not end with the first turn. Every `state_update` may carry the agent's background work as a complete list, which becomes a
 * `background` event whenever it changes. While that list has items, or a turn runs, the layer keeps reading: a `running` after an `idle` is a turn the
 * agent started on its own (the report of work that finished), and it ends at its own `idle` with its own `done`. When nothing is open and the session
 * is idle, the layer waits the handoff guard (`BACKGROUND_HANDOFF_MS`) for such a turn to begin, and then ends. `send` puts another prompt to the live
 * session; `turns.ts` keeps count of the turns that messages sent into the session lead to, so that one `done` ends the whole activity.
 *
 * Claude Code's own timers (a `Monitor`, a `ScheduleWakeup`, a one-shot `CronCreate`) are not in the agent's list, which would let the session end with
 * the turn and lose every tick and wakeup. The mapper makes a completed call of one a background item and the layer holds a timer for the time the agent
 * named in the call (`timed.ts`); the item leaves when it comes, once no turn is in flight (`expire`).
 *
 * A steer goes into the running turn one of two ways, by what the agent said in `initialize`. An agent that advertises `_meta.steering.supported` (Codex's
 * adapter) is asked with `_session/steering`, which it answers `injected` when the message went into the turn: it holds a plain prompt that comes during a
 * turn until the turn is over, and answers it as a turn of its own. One that does not (Claude Code's) is sent a plain prompt, which it inserts into the turn.
 * Either way a v2 agent can be steered.
 */
export class V2Layer implements ProtocolLayer {
    private connection?: ClientConnection;
    private sessionId?: string;
    /** The agent says it names sessions (`session.title`) and this session is new: it takes a title from the client, and may send one. */
    naming = false;
    answered = false;
    restartOn?: AgentProtocol;
    /** What the agent says, the timers and the messages in flight, in the order the loop reads them. */
    private channel = new Channel<Item>();
    /** Races a request against the end of the process or the run, once the connection is up: a message sent while the session waits cannot hang after a cancel. */
    private request: <T>(call: Promise<T>) => Promise<T> = call => call;
    private turns = new Turns();
    /** What turns the agent's updates into events and knows which sub-agents are open: made once the session is, for `stopItem`. */
    private mapper?: UpdateMapperV2;
    /** The agent said in `initialize` that it takes a steer through `_session/steering`; unknown (false) until it has answered. */
    private steerable = false;
    /** The background commands and tasks the client asked to cancel: the end of one of them is no work whose report the agent owes. */
    private stopped = new Set<string>();
    /** A turn is open: its prompt is with the agent and its `idle` has not come, so a steer may still land in it. */
    private open = false;
    /** Settles with `false` once the open turn is over, for a steer whose message has not been echoed by then. */
    private turnEnded: Promise<false>;
    private markEnded: () => void = () => undefined;
    /** The steers that wait for their message to be echoed, by its id. */
    private landing = new Map<string, () => void>();
    /** The conversation is over: nothing more is taken. */
    private finished = false;
    private timers: Partial<Record<Wake, { id: number; handle: ReturnType<typeof setTimeout> }>> = {};
    /** The time of each call that holds the session until a time it named, by the call's id (`Monitor`, `ScheduleWakeup`: see `timed.ts`). */
    private deadlines = new Map<string, ReturnType<typeof setTimeout>>();
    private timerCount = 0;

    constructor(private host: LayerHost) {
        this.turnEnded = this.latch();
    }

    /** A promise for the end of the turn that is open, and the call that settles it. */
    private latch(): Promise<false> {
        return new Promise<false>((resolve) => {
            this.markEnded = () => resolve(false);
        });
    }

    /**
     * Hands `text` to the turn in flight as a prompt, which the agent inserts into it. Answers whether it landed there: the agent echoes the message
     * (`user_message`, with the id its answer to the prompt names) before the turn's `idle`. The answer to the prompt alone says too little: Codex
     * holds a prompt that comes during a turn and answers it after that turn's `idle`, as a turn of its own that this layer never reads, and the SDK may
     * deliver that answer before the `idle` it follows. Such a message is the runtime's to send again.
     */
    async steer(text: string): Promise<boolean> {
        const { host, connection, sessionId } = this;

        if (!connection || !sessionId || host.signal.aborted || !this.open) {
            return false;
        }

        if (this.steerable) {
            return this.steerThroughExtension(connection, sessionId, text);
        }

        const entry = this.turns.add('steer');
        let landed = false;

        try {
            landed = await Promise.race([
                connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] }).then(({ messageId }) => {
                    this.turns.took(entry, messageId);

                    return this.landed(messageId);
                }),
                this.turnEnded,
            ]);
        }
        catch (error) {
            host.deps.log?.(`${ host.agent.id } refused a steer: ${ errorMessage(error) }`);
        }

        // A steer that did not land is the runtime's to send again: the agent owes no turn for it.
        if (!landed) {
            this.turns.drop(entry);
        }

        return landed;
    }

    /**
     * Hands `text` to the turn in flight through `_session/steering`, for an agent that advertises it. `injected` says the message is part of the turn that
     * runs, which says what it was asked and answers it in the same turn, so there is no other turn to wait for and nothing to count: the answer is the
     * agent's, not an echo to look for. Any other answer (no turn runs, or the agent took it as a turn of its own) leaves the message to the runtime.
     */
    private async steerThroughExtension(connection: ClientConnection, sessionId: string, text: string): Promise<boolean> {
        const { host } = this;

        try {
            return await steerByExtension(() => this.request(connection.agent.request<SteerResponse, SteerRequest>(STEER_METHOD, steerRequest(sessionId, text))), { running: () => this.open, aborted: () => host.signal.aborted });
        }
        catch (error) {
            if (!host.signal.aborted && !(error instanceof ProcessEnded)) {
                host.deps.log?.(`${ host.agent.id } refused a steer: ${ errorMessage(error) }`);
            }

            return false;
        }
    }

    /**
     * Puts `text` to the live session as a prompt of its own. The agent takes it in at once, or after the turn it is in (Claude's adapter answers a prompt
     * that comes during a turn when it begins to run it), and `true` says it did; the turn that answers it follows on the stream of `run`, and with it one
     * `done` for the whole activity: the `done` of a turn the agent had under way is held back until this prompt is answered. It does not wait for the
     * stream to be read, and it settles `false` when the session is over, the agent refuses the prompt, or the run is cancelled or the process leaves.
     */
    async send(text: string): Promise<boolean> {
        const { host, connection, sessionId } = this;

        if (!connection || !sessionId || this.finished || host.signal.aborted) {
            return false;
        }

        // Sent while no turn runs, the prompt begins a turn of its own, whenever the agent echoes it.
        const entry = this.turns.add('send', !this.open);
        let taken = false;

        // The wait for the agent's report does not end while the prompt is on its way.
        this.nudge();

        try {
            const { messageId } = await this.request(connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] }));

            this.turns.took(entry, messageId);
            taken = !this.finished;
        }
        catch (error) {
            if (!host.signal.aborted && !(error instanceof ProcessEnded)) {
                host.deps.log?.(`${ host.agent.id } refused a prompt: ${ errorMessage(error) }`);
            }
        }

        if (!taken) {
            this.turns.drop(entry);
        }

        this.nudge();

        return taken;
    }

    /**
     * Asks the agent to end one thing it has open and nothing else. A sub-agent (`id` is its session id): the ordinary `session/cancel` notification with
     * the child's session id, which Claude's adapter takes as a request to stop that child's work (its terminals end, its calls are cancelled, it says
     * `idle` with the stop reason `cancelled`, and its parent's list loses it), leaving its siblings and the parent alone; only for a child the agent announced
     * with the permission to cancel it and that has not ended. A background command (`id` is its terminal's id): `terminal/cancel`, which both adapters
     * take for a terminal their `background` list names and that said it can be cancelled, and which stops that process and nothing else (the terminal
     * gets an `exitStatus` and the list loses it). A background task (`id` is its tool call's id, Claude's `Workflow`): `tool_call/cancel`, for a call that said
     * it can be cancelled (the call ends `cancelled` and the list loses it). A terminal or call that is unknown, has ended or cannot be cancelled is refused
     * with `-32602`, which says it is gone. The end itself comes as updates on the stream of `run`. Answers whether the agent took the request.
     */
    async stopItem(id: string): Promise<boolean> {
        const { host, connection, mapper, sessionId } = this;

        if (!connection || !mapper || !sessionId || this.finished || host.signal.aborted) {
            return false;
        }

        const subagent = mapper.stoppable(id);
        const command = !subagent && mapper.stoppableCommand(id);
        const task = !subagent && !command && mapper.stoppableTask(id);

        if (!subagent && !command && !task) {
            return false;
        }

        try {
            if (command || task) {
                // Before the answer: the end of the work follows at once, and it is no work whose report the agent owes.
                this.stopped.add(id);
                await this.request(command
                    ? connection.agent.request(methods.agent.terminal.cancel, { sessionId, terminalId: id })
                    : connection.agent.request(methods.agent.toolCall.cancel, { sessionId, toolCallId: id }));
            }
            else {
                await this.request(connection.agent.notify(methods.agent.session.cancel, { sessionId: id }));
            }

            return true;
        }
        catch (error) {
            if (command || task) {
                this.stopped.delete(id);
            }

            // `-32602`: the terminal is gone already (it ended on its own), which is not a failure to log.
            if (!host.signal.aborted && !(error instanceof ProcessEnded) && !(error instanceof RequestError && error.code === INVALID_PARAMS)) {
                host.deps.log?.(`${ host.agent.id } could not be asked to stop ${ id }: ${ errorMessage(error) }`);
            }

            return false;
        }
    }

    /** Settles with `true` once the agent has echoed the message `id` back, which `run` sees in the order the agent said things. */
    private landed(id: string): Promise<true> {
        return this.turns.echoed(id) ? Promise.resolve(true) : new Promise<true>((resolve) => {
            this.landing.set(id, () => resolve(true));
        });
    }

    /** The open turn is over: the prompt takes no steer any more, and one that has not been echoed will not be. The next turn that begins opens it again. */
    private endTurn(): void {
        this.open = false;
        this.host.promptIs('over');
        this.markEnded();
        this.turnEnded = this.latch();
    }

    /** Wakes the loop, which looks again at what it waits for. */
    private nudge(): void {
        if (!this.finished) {
            this.channel.push({ kind: 'nudge' });
        }
    }

    /** How long a session with nothing open waits before it ends: the long wait for a report that is owed, the short guard after a turn of its own. */
    private guard(course: Course): number {
        const { backgroundHandoffMs, backgroundReportMs } = this.host.deps;

        return course.owed ? backgroundReportMs ?? backgroundHandoffMs ?? BACKGROUND_REPORT_MS : backgroundHandoffMs ?? BACKGROUND_HANDOFF_MS;
    }

    /** Starts the timer `which` for `ms` unless it runs already. */
    private arm(which: Wake, ms: number): void {
        if (this.timers[which] || this.finished) {
            return;
        }

        const id = ++this.timerCount;
        const handle = setTimeout(() => this.channel.push({ kind: 'timer', which, id }), ms);

        handle.unref();
        this.timers[which] = { id, handle };
    }

    private disarm(which: Wake): void {
        const timer = this.timers[which];

        if (timer) {
            clearTimeout(timer.handle);
            delete this.timers[which];
        }
    }

    /** Starts the timer of the call `toolCallId`, which runs `ms`: the end of what the agent scheduled in it. */
    private setDeadline(toolCallId: string, ms: number): void {
        if (this.deadlines.has(toolCallId) || this.finished) {
            return;
        }

        const handle = setTimeout(() => this.channel.push({ kind: 'deadline', toolCallId }), ms);

        handle.unref();
        this.deadlines.set(toolCallId, handle);
    }

    /** Stops every call's timer: the conversation is over, and none of them may outlive it. */
    private clearDeadlines(): void {
        for (const handle of this.deadlines.values()) {
            clearTimeout(handle);
        }

        this.deadlines.clear();
    }

    /** Whether the timer item `id` is the timer that runs now, and not one that was stopped after it went off. A timer that went off is spent. */
    private fires(which: Wake, id: number): boolean {
        if (this.timers[which]?.id !== id) {
            return false;
        }

        delete this.timers[which];

        return true;
    }

    /** The handshake: what the client is and can do, and what the agent offers. Rejects when the agent refuses it, does not answer in time, or the process or the run ends. */
    private initialize(connection: ClientConnection, request: <T>(call: Promise<T>) => Promise<T>) {
        const { host } = this;

        return answeredInTime(request(connection.agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            info: { name: 'clowdy', title: 'Clowdy', version: host.deps.clientVersion },
            capabilities: clientCapabilities(host.agent),
        })), host);
    }

    /**
     * The handshake, then `session/fork` of `sessionId` with the fork point in `_meta.jetbrains.air.fork` (`{ version: 1, messageId }`: a vendor extension that
     * both pinned adapters read, which makes the copy end with that message, inclusive), then `session/close` of the new session. The fork is made as a resume
     * is opened (the folder, the project's other folders, the system prompt and the tools' MCP server, the agent's own options), and the agent starts the new
     * session, so it could be prompted at once; here it only ends, and the next turn resumes it. What the agent says on the way is nobody's news. The agent
     * saying it does not fork, a point or a session it cannot find, and a process that fails reject with an `EngineFailure`.
     */
    async fork(sessionId: string, ref: string): Promise<EngineFork> {
        const { host } = this;
        const { agent, proc, signal } = host;
        const context = { agent: agent.name, login: agent.login };
        const app = client({ name: 'clowdy' }).onNotification(methods.client.session.update, () => undefined);
        const connection = app.connect(ndJsonStream(Writable.toWeb(proc.child.stdin as Writable) as WritableStream<Uint8Array>, Readable.toWeb(proc.child.stdout as Readable) as ReadableStream<Uint8Array>));

        this.connection = connection;

        const request = watchEnd(proc, signal, () => undefined);
        let timer: ReturnType<typeof setTimeout> | undefined;

        try {
            let init;

            try {
                init = await this.initialize(connection, request);
            }
            catch (error) {
                if (signal.aborted || !answeredNo(error)) {
                    throw error;
                }

                throw new EngineFailure(`${ agent.name } does not speak ACP v2, which a fork needs`, false, 'invalid_request');
            }

            const capabilities = init.capabilities?.session;

            if (!capabilities?.fork) {
                throw new EngineFailure(`${ agent.name } cannot fork a conversation: its adapter offers no session/fork`, false, 'invalid_request');
            }

            // The handshake has its own limit (`initializeTimeoutMs`, and a program that is slow to start is slow there); this one is for the copy itself.
            const timeoutMs = host.deps.forkTimeoutMs ?? FORK_TIMEOUT_MS;
            const slow = new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new EngineFailure(`${ agent.name } did not finish the fork in ${ Math.max(1, Math.round(timeoutMs / 1000)) } s`, true, 'unknown')), timeoutMs);
            });

            slow.catch(() => undefined);

            const shared = sessionRequest(host, capabilities);
            const forked = await Promise.race([
                request(connection.agent.request(methods.agent.session.fork, { sessionId, ...shared, _meta: { ...shared._meta, jetbrains: { air: { fork: { version: 1, messageId: ref } } } } })),
                slow,
            ]);

            // The copy is on disk and the new session open in the adapter; closing it lets the agent settle what it keeps before its process is stopped. A close
            // that fails loses nothing: the next turn resumes the session from the copy.
            await Promise.race([request(connection.agent.request(methods.agent.session.close, { sessionId: forked.sessionId })).catch(() => undefined), slow.catch(() => undefined)]);

            return { sessionId: forked.sessionId };
        }
        catch (error) {
            if (error instanceof EngineFailure) {
                throw error;
            }

            if (signal.aborted) {
                throw new EngineFailure('The fork was cancelled', false, 'cancelled');
            }

            const { message, retryable, code } = error instanceof ProcessEnded
                ? processEnded(context, `exit code ${ proc.child.exitCode ?? 'unknown' }`, proc.stderr())
                : classifyThrown(error, context, proc.stderr());

            throw new EngineFailure(message, retryable, code);
        }
        finally {
            clearTimeout(timer);
        }
    }

    cancel(): Promise<void> {
        const { connection, sessionId } = this;

        // Before the session exists the connection may not be initialized, and a notification would wait for that.
        return connection && sessionId ? connection.agent.notify(methods.agent.session.cancel, { sessionId }).catch(() => undefined) : Promise.resolve();
    }

    disconnect(): void {
        this.connection?.close();
    }

    /** The conversation with a running agent, from `initialize` to the end of the session: the last turn when nothing is open, or the run's end. */
    async *run(): AsyncGenerator<EngineEvent> {
        const { host, channel } = this;
        const { agent, proc, options, signal, deps } = host;
        const context = { agent: agent.name, login: agent.login };
        let current: string | undefined;
        // What the session says before the prompt is in (the state it resumed in, a replay of its history) is not news of the turn.
        let listening = false;
        // The sessions of the sub-agents the session announced, in the order the agent said so: a child's first word comes after its announcement.
        const children = new Set<string>();

        const app = client({ name: 'clowdy' })
            .onNotification(methods.client.session.update, ({ params }) => {
                if (!listening) {
                    return;
                }

                if (params.sessionId === current) {
                    if (isResumeWarningUpdate(params.update)) {
                        return;
                    }

                    if (params.update.sessionUpdate === 'session_info_update' && typeof params.update.title === 'string') {
                        host.offerTitle(params.update.title);
                    }

                    if (SessionUpdate.isSubagentUpdate(params.update)) {
                        children.add(params.update.sessionId);
                    }

                    channel.push({ kind: 'update', update: params.update });
                }
                else if (children.has(params.sessionId)) {
                    // A sub-agent of a sub-agent is announced on the session of the one that started it.
                    if (SessionUpdate.isSubagentUpdate(params.update)) {
                        children.add(params.update.sessionId);
                    }

                    channel.push({ kind: 'update', update: params.update, from: params.sessionId });
                }
            })
            .onRequest(methods.client.session.requestPermission, async ({ params }) => {
                const optionId = await host.pickPermission(paramsOfV2(params));

                return { outcome: optionId === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId } };
            });

        const input = Readable.toWeb(proc.child.stdout as Readable) as ReadableStream<Uint8Array>;
        const output = Writable.toWeb(proc.child.stdin as Writable) as WritableStream<Uint8Array>;
        const connection = app.connect(ndJsonStream(output, input));

        this.connection = connection;

        // Either end of the process or the run also wakes the loop that waits for the agent's next word, so a cancelled session ends at once.
        const request = watchEnd(proc, signal, ending => channel.push({ kind: ending }));

        this.request = request;

        try {
            let init;

            try {
                init = await this.initialize(connection, request);
            }
            catch (error) {
                if (signal.aborted || !answeredNo(error)) {
                    throw error;
                }

                // An agent that speaks v1 only answers with version 1 (a result that is no v2 one) or fails the handshake outright. The start of a
                // validation error says what in the answer was not v2's, which is all that tells a v2 agent whose answer drifted from the draft.
                console.warn(`[clowdy] ${ agent.name } does not speak ACP v2 (${ error instanceof RequestError ? error.message : `its answer is not a v2 one: ${ errorMessage(error).slice(0, 300) }` }); starting it again on v1`);
                this.restartOn = 'v1';

                return;
            }

            this.steerable = advertisesSteering(init);

            const capabilities = init.capabilities?.session;

            if (!capabilities) {
                yield { type: 'error', message: `${ agent.name } offers no sessions over ACP v2`, code: 'invalid_request' };

                return;
            }

            const supportsSystemPrompt = Boolean(capabilities.systemPrompt);
            const shared = sessionRequest(host, capabilities);

            let configOptions: SessionConfigOption[] | undefined;
            let resumed = false;

            if (options.resumeSessionId) {
                const id = options.resumeSessionId;

                try {
                    // No `replayFrom`: the agent takes the session up where it was without sending its history again, as v1's `session/resume` did.
                    // Whatever it sends before it answers (its current state, a replay if it sends one anyway) is dropped, since nothing listens yet.
                    configOptions = (await request(connection.agent.request(methods.agent.session.resume, { sessionId: id, ...shared }))).configOptions;
                    resumed = true;
                }
                catch (error) {
                    if (signal.aborted || error instanceof ProcessEnded) {
                        throw error;
                    }

                    console.warn(`[clowdy] ${ agent.name } could not continue session ${ id }; starting a new one: ${ errorMessage(error) }`);
                }

                if (resumed) {
                    current = id;
                }
            }

            if (!resumed) {
                const created = await request(connection.agent.request(methods.agent.session.new, shared));

                current = created.sessionId;
                configOptions = created.configOptions;
                deps.costs.set(created.sessionId, 0);
            }

            const id = current as string;

            this.naming = Boolean(capabilities.title) && !resumed;
            this.sessionId = id;
            yield { type: 'session', sessionId: id };

            await applyChoices({
                agent: agent.name,
                options: selectsOf(configOptions),
                model: options.model,
                effort: options.effort,
                mode: agent.permission?.mode,
                set: async ({ configId, value }) => {
                    const answer = await request(connection.agent.request(methods.agent.session.setConfigOption, { sessionId: id, configId, type: 'id', value }));

                    return selectsOf(answer.configOptions);
                },
            });

            await keepTitle({ agent: agent.name, signal, title: options.title, naming: this.naming }, keep => request(connection.agent.request(methods.agent.session.setTitle, { sessionId: id, title: keep })));

            // An agent that was to continue a conversation and starts a new one has not seen it: it is told what it said, so the work is not lost.
            const record = options.resumeSessionId && !resumed ? host.record() : undefined;
            const preface = prefaceOf({ systemPrompt: options.systemPrompt, supportsSystemPrompt, resumed, record });
            const mapper = new UpdateMapperV2({ toolNames: options.tools.map(tool => tool.name), costBefore: deps.costs.get(id), log: deps.log });

            this.mapper = mapper;

            // The answer says the message was inserted, not that the turn is over; only a refusal of it ends the turn here.
            listening = true;
            this.open = true;
            void connection.agent.request(methods.agent.session.prompt, { sessionId: id, prompt: [{ type: 'text', text: `${ preface }${ options.prompt }` } satisfies ContentBlock] }).then(
                () => undefined,
                error => channel.push({ kind: 'failed', error })
            );
            host.promptIs('running');

            yield* this.converse(id, mapper);
        }
        catch (error) {
            if (signal.aborted) {
                return;
            }

            if (error instanceof ProcessEnded) {
                yield failureEvent(processEnded(context, `exit code ${ proc.child.exitCode ?? 'unknown' }`, proc.stderr()));

                return;
            }

            yield failureEvent(classifyThrown(error, context, proc.stderr()));
        }
        finally {
            this.finished = true;
            this.disarm('handoff');
            this.disarm('release');
            this.clearDeadlines();
            this.markEnded();
        }
    }

    /**
     * Reads what the agent says for as long as the session lives: the first turn, and what follows it. Gives back when a turn failed, the run was
     * cancelled, the process left, or nothing has been open for the length of the handoff guard.
     */
    private async *converse(id: string, mapper: UpdateMapperV2): AsyncGenerator<EngineEvent> {
        const course: Course = { working: false, held: false, delivered: false, owed: false, items: [], calls: [], listed: [], lapsed: new Set() };

        for (;;) {
            const item = await this.channel.next();

            if (this.host.signal.aborted || item.kind === 'aborted') {
                return;
            }

            if (yield* this.take(item, id, course, mapper)) {
                return;
            }

            yield* this.expire(course, mapper);

            // Nothing is open and no turn runs: the session is wound up, unless the agent starts a turn within the guard.
            if (this.quiet(course)) {
                this.arm('handoff', this.guard(course));
            }
            else {
                this.disarm('handoff');
            }
        }
    }

    /** A turn is in flight or on its way: the one that runs, a `done` held for another, a prompt sent into the session that has not been answered. */
    private busy(course: Course): boolean {
        return course.working || course.held || this.turns.sending;
    }

    /**
     * The calls whose time came leave the list, once no turn is in flight. A turn that runs when a call's time comes is no report of it: the agent's notice of
     * its end (a monitor's last, a wakeup's turn) begins after that turn, so the session is kept until the turn's `done` is said, and then waits for the
     * report as for any work that ends between turns (`owed`).
     */
    private *expire(course: Course, mapper: UpdateMapperV2): Generator<EngineEvent> {
        if (course.lapsed.size === 0 || this.busy(course)) {
            return;
        }

        const lapsed = [...course.lapsed].filter(id => mapper.lapse(id));

        course.lapsed.clear();

        if (lapsed.length > 0) {
            yield* this.publish(course, mapper);
        }
    }

    /** Whether a `done` has been said and nothing is open since: no turn, no held `done`, no background work, no prompt sent into the session. */
    private quiet(course: Course): boolean {
        return course.delivered && !this.busy(course) && course.items.length === 0;
    }

    /** One thing the loop was woken for. Gives back whether the conversation is over. */
    private async *take(item: Item, id: string, course: Course, mapper: UpdateMapperV2): AsyncGenerator<EngineEvent, boolean> {
        const { host } = this;
        const { agent, proc } = host;
        const context = { agent: agent.name, login: agent.login };

        switch (item.kind) {
            case 'update':
                return item.from === undefined ? yield* this.heard(item.update, id, course, mapper) : yield* this.heardOfChild(item.update, item.from, mapper);
            case 'timer':
                return yield* this.timed(item, id, course, mapper);
            case 'deadline':
                this.deadlines.delete(item.toolCallId);
                course.lapsed.add(item.toolCallId);

                return false;
            case 'nudge':
                // A prompt that a turn waited for was refused: there may be nothing left to wait for.
                if (course.held && !course.working && !this.review().blocked) {
                    yield* this.deliver(id, course, mapper, false);
                }

                return false;
            case 'exited':
                this.endTurn();

                // The agent leaving when nothing was open loses nothing, and the guard would have ended the session about now.
                if (!this.quiet(course)) {
                    yield failureEvent(processEnded(context, `exit code ${ proc.child.exitCode ?? 'unknown' }`, proc.stderr()));
                }

                return true;
            case 'failed':
                this.endTurn();
                yield* mapper.close();
                yield failureEvent(classifyThrown(item.error, context, proc.stderr()));

                return true;
            default:
                return true;
        }
    }

    /** One update of the session. Gives back whether the conversation is over. */
    private async *heard(update: SessionUpdate, id: string, course: Course, mapper: UpdateMapperV2): AsyncGenerator<EngineEvent, boolean> {
        if (SessionUpdate.isUserMessage(update) || SessionUpdate.isUserMessageChunk(update)) {
            this.turns.echo(update.messageId);
            this.landing.get(update.messageId)?.();
            this.landing.delete(update.messageId);

            return false;
        }

        if (!SessionUpdate.isStateUpdate(update)) {
            yield* mapper.update(update);

            // A call that schedules something the agent will be woken by (a completed `Monitor`, `ScheduleWakeup` or one-shot `CronCreate`) holds the session
            // until its time, which is told before the turn's `idle`: the runtime then keeps the session for it.
            const armed = mapper.armed();

            for (const { id: toolCallId, ms } of armed) {
                this.setDeadline(toolCallId, ms);
            }

            // What names an item (a terminal's command, a sub-agent's title, a call's title) may come after the list that names the item.
            if (armed.length > 0 || (course.listed.length > 0 && (SessionUpdate.isTerminalUpdate(update) || SessionUpdate.isSubagentUpdate(update) || SessionUpdate.isToolCallUpdate(update)))) {
                yield* this.publish(course, mapper);
            }

            return false;
        }

        // A state that carries no list says nothing of the background work: the last list stands.
        if ('background' in update && Array.isArray(update.background)) {
            course.listed = update.background;
            yield* this.publish(course, mapper);
        }

        // `requires_action` pauses the turn: the agent waits on a person, the daemon answers its permission requests as they come, and the turn goes
        // on with `running` or ends with `idle`. Either one, after an `idle`, begins a turn; the agent says so whenever foreground work starts, and an
        // `idle` before it, with a stop reason or without, is a snapshot of the state the session was in ("repeated snapshots may carry the last stop
        // reason"), not the end of a turn.
        if (StateUpdate.isRunning(update) || StateUpdate.isRequiresAction(update)) {
            this.begin(course);
        }

        if (!StateUpdate.isIdle(update) || !course.working) {
            return false;
        }

        return yield* this.ended(update, id, course, mapper);
    }

    /** One update of a sub-agent's session. What it does is the child's own: the session's turn, its state and its list of background work are not touched by it. */
    private async *heardOfChild(update: SessionUpdate, from: string, mapper: UpdateMapperV2): AsyncGenerator<EngineEvent, boolean> {
        yield* mapper.update(update, from);

        return false;
    }

    /** The agent says a turn is in progress. After an `idle` that is a new one: a turn it starts on its own, or the one a message sent into the session leads to. */
    private begin(course: Course): void {
        if (course.working) {
            return;
        }

        course.working = true;
        // A turn that answers a message sent into the session is not the report that is owed: that one may still come.
        course.owed &&= this.turns.sending;
        this.turns.begin();
        this.open = true;
        this.host.promptIs('running');
        // The turn the guards waited for has begun.
        this.disarm('handoff');
        this.disarm('release');
    }

    /** Tells the runtime the background work when it changed, with the names the mapper knows by now. */
    private *publish(course: Course, mapper: UpdateMapperV2): Generator<EngineEvent> {
        // A sub-agent the list lost has finished: the card of its call says so, before the list does.
        yield* mapper.listed(course.listed);

        const items = mapper.background(course.listed);
        const calls = mapper.openCalls(course.listed);

        if (JSON.stringify(items) !== JSON.stringify(course.items) || JSON.stringify(calls) !== JSON.stringify(course.calls)) {
            // The last work ended between turns: Claude Code reports it with a turn of its own. Not an agent that starts none (the runtime tells it, once
            // this snapshot is read: `wakesOnBackgroundEnd`), and not commands or tasks the client stopped, which give the agent no report.
            course.owed ||= course.items.length > 0 && items.length === 0 && !course.working && !this.host.agent.wakesOnBackgroundEnd && !course.items.every(item => this.stopped.has(item.id));
            course.items = items;
            course.calls = calls;

            yield { type: 'background', items, ...(calls.length > 0 && { calls }) };
        }
    }

    /** What the turn that just ended leaves to wait for: whether its `done` is held back, and whether a message that landed in it may have a turn of its own to come. */
    private review(): { blocked: boolean; landed: boolean } {
        const { landed, queued, answered } = this.turns.review();

        // A prompt the agent has not begun (queued behind the turn that ended) holds the turn's `done` back, unless the turn was that prompt's own.
        return { blocked: landed > 0 || (answered === 0 && queued > 0), landed: landed > 0 };
    }

    /**
     * An `idle` that ends the turn in progress. Its `done` is said now, unless a message waits for a turn that is to come: one that landed in the turn
     * (Claude's adapter answers it with a turn of its own, an `idle` and a `running` away) or one the agent has not begun. Gives back whether the
     * conversation is over.
     */
    private async *ended(update: IdleStateUpdate, id: string, course: Course, mapper: UpdateMapperV2): AsyncGenerator<EngineEvent, boolean> {
        const { agent, proc } = this.host;

        course.working = false;
        this.endTurn();
        course.tokens = summed(course.tokens, update.usage);

        const failure = IdleStateUpdate.isError(update)
            ? failureEvent(classifyThrown(update.error ?? new Error(`${ agent.name } stopped with an error`), { agent: agent.name, login: agent.login }, proc.stderr()))
            : stopFailure(update.stopReason, agent.name);

        if (failure) {
            yield* mapper.stop(course.tokens);
            this.costed(id, mapper);
            this.answered = false;
            yield failure;

            return true;
        }

        const { blocked, landed } = this.review();

        if (blocked) {
            course.held = true;
            yield* mapper.close();

            // A message that landed in a turn that says no more may have been folded into it: the agent gets the guard to begin the turn that answers it.
            if (landed) {
                mapper.expectRepeat();
                this.arm('release', this.host.deps.backgroundHandoffMs ?? BACKGROUND_HANDOFF_MS);
            }

            return false;
        }

        yield* this.deliver(id, course, mapper, false);

        return false;
    }

    /**
     * Says the `done` of the activity that just ended: its usage, summed over its turns, and one `done` for each prompt sent into the session that it
     * answers (a turn the agent started on its own has one too). `fold`: the messages that landed in the last turn were folded into it.
     */
    private async *deliver(id: string, course: Course, mapper: UpdateMapperV2, fold: boolean): AsyncGenerator<EngineEvent> {
        const sends = this.turns.release(fold);

        yield* mapper.stop(course.tokens);
        this.costed(id, mapper);

        const result = mapper.result();

        mapper.next();
        course.tokens = undefined;
        course.held = false;
        course.delivered = true;
        this.answered = true;
        this.disarm('release');

        for (let owed = Math.max(1, sends); owed > 0; owed--) {
            yield { type: 'done', result };
        }
    }

    /** What the session has cost so far, which the next prompt of this session is measured from. */
    private costed(id: string, mapper: UpdateMapperV2): void {
        if (mapper.cost !== undefined) {
            this.host.deps.costs.set(id, mapper.cost);
        }
    }

    /** A timer went off. Gives back whether the conversation is over. */
    private async *timed(item: Extract<Item, { kind: 'timer' }>, id: string, course: Course, mapper: UpdateMapperV2): AsyncGenerator<EngineEvent, boolean> {
        if (!this.fires(item.which, item.id)) {
            return false;
        }

        if (item.which === 'release') {
            // No turn came for the message that landed: the agent folded it into the turn it landed in, which answered it.
            if (course.held && !course.working) {
                yield* this.deliver(id, course, mapper, true);
            }

            return false;
        }

        // Nothing opened within the guard: the report turn, if there was to be one, did not come.
        return this.quiet(course);
    }
}
