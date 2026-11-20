import { client, ContentBlock, IdleStateUpdate, methods, ndJsonStream, PROTOCOL_VERSION, RequestError, SessionConfigOption, SessionUpdate, StateUpdate } from '@agentclientprotocol/sdk/experimental/v2/unstable';
import { Readable, Writable } from 'node:stream';

import { errorMessage } from '../../errors';
import { answeredInTime, Channel, ProcessEnded, watchEnd } from './connection';
import { applyChoices, isResumeWarning, keepTitle, prefaceOf, stopFailure } from './conversation';
import { classifyThrown, failureEvent, processEnded } from './failure';
import { BACKGROUND_HANDOFF_MS, BACKGROUND_REPORT_MS } from './layer';
import { UpdateMapperV2 } from './mapper-v2';
import { Turns } from './turns';

import type { BackgroundWork, ClientCapabilities, ClientConnection, NewSessionRequest } from '@agentclientprotocol/sdk/experimental/v2/unstable';
import type { BackgroundItem } from '@clowdy/protocol';
import type { EngineEvent } from '../types';
import type { AgentProtocol } from './catalog';
import type { SelectOption } from './conversation';
import type { LayerHost, ProtocolLayer } from './layer';
import type { Tokens } from './mapper-core';
import type { ResolvedAgent } from './registry';

/**
 * What the client tells an agent it can do in `initialize`: nothing. Clowdy offers no file access and no terminal (ACP v2 has neither; an agent's tools
 * are its own, and the runtime's reach it through an MCP server).
 */
const clientCapabilities = (agent: Pick<ResolvedAgent, 'clientMeta'>): ClientCapabilities => ({ ...(agent.clientMeta && { _meta: agent.clientMeta }) });

/** The timers of a session that lives on: the handoff guard before it ends, and the wait for the turn that a message which landed in a turn may have to come. */
type Wake = 'handoff' | 'release';

type Item =
    /** An update of the session the engine talks to, or, with `from`, of a sub-agent's session. */
    | { kind: 'update'; update: SessionUpdate; from?: string }
    | { kind: 'failed'; error: unknown }
    | { kind: 'exited' }
    | { kind: 'aborted' }
    | { kind: 'timer'; which: Wake; id: number }
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
    /** The agent's own list behind `items`. */
    listed: BackgroundWork[];
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

        const entry = this.turns.add('send');
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
     * Asks the agent to end the sub-agent whose session is `agentId`, and nothing else: it sends the ordinary `session/cancel` notification with the child's
     * session id, which Claude's adapter takes as a request to stop that child's work (its terminals end, its calls are cancelled, it says `idle` with the
     * stop reason `cancelled`, and its parent's list loses it), leaving its siblings and the parent alone. Only for a child the agent announced with the
     * permission to cancel it and that has not ended; the end itself comes as updates on the stream of `run`. Answers whether the notification was written.
     */
    async stopItem(agentId: string): Promise<boolean> {
        const { host, connection, mapper } = this;

        if (!connection || !mapper || this.finished || host.signal.aborted || !mapper.stoppable(agentId)) {
            return false;
        }

        try {
            await this.request(connection.agent.notify(methods.agent.session.cancel, { sessionId: agentId }));

            return true;
        }
        catch (error) {
            if (!host.signal.aborted && !(error instanceof ProcessEnded)) {
                host.deps.log?.(`${ host.agent.id } could not be asked to stop ${ agentId }: ${ errorMessage(error) }`);
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

    /** Whether the timer item `id` is the timer that runs now, and not one that was stopped after it went off. A timer that went off is spent. */
    private fires(which: Wake, id: number): boolean {
        if (this.timers[which]?.id !== id) {
            return false;
        }

        delete this.timers[which];

        return true;
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
            .onRequest(methods.client.session.requestPermission, ({ params }) => {
                const optionId = host.pickPermission(params.options);

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
                init = await answeredInTime(request(connection.agent.request(methods.agent.initialize, {
                    protocolVersion: PROTOCOL_VERSION,
                    info: { name: 'clowdy', title: 'Clowdy', version: deps.clientVersion },
                    capabilities: clientCapabilities(agent),
                })), host);
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

            const capabilities = init.capabilities?.session;

            if (!capabilities) {
                yield { type: 'error', message: `${ agent.name } offers no sessions over ACP v2`, code: 'invalid_request' };

                return;
            }

            const access = host.openBridge();
            const supportsSystemPrompt = Boolean(capabilities.systemPrompt);
            // Only an agent that advertises the field gets it, as in v1; the list may differ on a resume while `cwd` stays.
            const directories = capabilities.additionalDirectories ? options.additionalDirectories ?? [] : [];
            const shared: NewSessionRequest = {
                cwd: options.cwd,
                mcpServers: access?.server ? [{ type: 'stdio', ...access.server }] : [],
                ...(directories.length > 0 && { additionalDirectories: directories }),
                ...(agent.sessionMeta && { _meta: agent.sessionMeta }),
                ...(supportsSystemPrompt && options.systemPrompt && { systemPrompt: { mode: 'append', content: [{ type: 'text', text: options.systemPrompt }] } }),
            };

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
            this.markEnded();
        }
    }

    /**
     * Reads what the agent says for as long as the session lives: the first turn, and what follows it. Gives back when a turn failed, the run was
     * cancelled, the process left, or nothing has been open for the length of the handoff guard.
     */
    private async *converse(id: string, mapper: UpdateMapperV2): AsyncGenerator<EngineEvent> {
        const course: Course = { working: false, held: false, delivered: false, owed: false, items: [], listed: [] };

        for (;;) {
            const item = await this.channel.next();

            if (this.host.signal.aborted || item.kind === 'aborted') {
                return;
            }

            if (yield* this.take(item, id, course, mapper)) {
                return;
            }

            // Nothing is open and no turn runs: the session is wound up, unless the agent starts a turn within the guard.
            if (this.quiet(course)) {
                this.arm('handoff', this.guard(course));
            }
            else {
                this.disarm('handoff');
            }
        }
    }

    /** Whether a `done` has been said and nothing is open since: no turn, no held `done`, no background work, no prompt sent into the session. */
    private quiet(course: Course): boolean {
        return course.delivered && !course.working && !course.held && course.items.length === 0 && !this.turns.sending;
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

            // What names an item (a terminal's command, a sub-agent's title, a call's title) may come after the list that names the item.
            if (course.listed.length > 0 && (SessionUpdate.isTerminalUpdate(update) || SessionUpdate.isSubagentUpdate(update) || SessionUpdate.isToolCallUpdate(update))) {
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

        if (JSON.stringify(items) !== JSON.stringify(course.items)) {
            // The last work ended between turns: Claude Code reports it with a turn of its own.
            course.owed ||= course.items.length > 0 && items.length === 0 && !course.working;
            course.items = items;

            yield { type: 'background', items };
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
