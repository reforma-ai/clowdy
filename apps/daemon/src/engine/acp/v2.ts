import { client, ContentBlock, IdleStateUpdate, methods, ndJsonStream, PROTOCOL_VERSION, RequestError, SessionConfigOption, SessionUpdate, StateUpdate } from '@agentclientprotocol/sdk/experimental/v2/unstable';
import { Readable, Writable } from 'node:stream';

import { errorMessage } from '../../errors';
import { answeredInTime, Channel, ProcessEnded, watchEnd } from './connection';
import { applyChoices, isResumeWarning, keepTitle, prefaceOf, stopFailure } from './conversation';
import { classifyThrown, failureEvent, processEnded } from './failure';
import { UpdateMapperV2 } from './mapper-v2';

import type { ClientCapabilities, ClientConnection, NewSessionRequest } from '@agentclientprotocol/sdk/experimental/v2/unstable';
import type { EngineEvent } from '../types';
import type { AgentProtocol } from './catalog';
import type { SelectOption } from './conversation';
import type { LayerHost, ProtocolLayer } from './layer';
import type { ResolvedAgent } from './registry';

/**
 * What the client tells an agent it can do in `initialize`: nothing. Clowdy offers no file access and no terminal (ACP v2 has neither; an agent's tools
 * are its own, and the runtime's reach it through an MCP server).
 */
const clientCapabilities = (agent: Pick<ResolvedAgent, 'clientMeta'>): ClientCapabilities => ({ ...(agent.clientMeta && { _meta: agent.clientMeta }) });

type Item =
    | { kind: 'update'; update: SessionUpdate }
    | { kind: 'failed'; error: unknown }
    | { kind: 'exited' }
    | { kind: 'aborted' };

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
 */
export class V2Layer implements ProtocolLayer {
    private connection?: ClientConnection;
    private sessionId?: string;
    /** The agent says it names sessions (`session.title`) and this session is new: it takes a title from the client, and may send one. */
    naming = false;
    answered = false;
    restartOn?: AgentProtocol;
    /** Settles with `false` once the turn is over, for a steer whose message has not been echoed by then. */
    private ended: Promise<false>;
    private markEnded: () => void = () => undefined;
    /** The messages the agent has echoed back as the person's while the turn ran, by id: a prompt it inserted into the turn shows there. */
    private echoed = new Set<string>();
    /** The steers that wait for their message to be echoed, by its id. */
    private landing = new Map<string, () => void>();

    constructor(private host: LayerHost) {
        this.ended = new Promise<false>((resolve) => {
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

        if (!connection || !sessionId || host.signal.aborted) {
            return false;
        }

        try {
            return await Promise.race([
                connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] }).then(({ messageId }) => this.landed(messageId)),
                this.ended,
            ]);
        }
        catch (error) {
            host.deps.log?.(`${ host.agent.id } refused a steer: ${ errorMessage(error) }`);

            return false;
        }
    }

    /** Settles with `true` once the agent has echoed the message `id` back, which `run` sees in the order the agent said things. */
    private landed(id: string): Promise<true> {
        return this.echoed.has(id) ? Promise.resolve(true) : new Promise<true>((resolve) => {
            this.landing.set(id, () => resolve(true));
        });
    }

    /** The turn is over: the prompt takes no steer any more, and one that has not been echoed will not be. */
    private over(): void {
        this.host.promptIs('over');
        this.markEnded();
    }

    cancel(): Promise<void> {
        const { connection, sessionId } = this;

        // Before the session exists the connection may not be initialized, and a notification would wait for that.
        return connection && sessionId ? connection.agent.notify(methods.agent.session.cancel, { sessionId }).catch(() => undefined) : Promise.resolve();
    }

    disconnect(): void {
        this.connection?.close();
    }

    /** The conversation with a running agent, from `initialize` to the last event of the turn. */
    async *run(): AsyncGenerator<EngineEvent> {
        const { host } = this;
        const { agent, proc, options, signal, deps } = host;
        const context = { agent: agent.name, login: agent.login };
        const channel = new Channel<Item>();
        let current: string | undefined;
        // What the session says before the prompt is in (the state it resumed in, a replay of its history) is not news of the turn.
        let listening = false;

        const app = client({ name: 'clowdy' })
            .onNotification(methods.client.session.update, ({ params }) => {
                // A sub-agent is a session of its own in v2: what it says is dropped for now.
                if (listening && params.sessionId === current && !isResumeWarningUpdate(params.update)) {
                    if (params.update.sessionUpdate === 'session_info_update' && typeof params.update.title === 'string') {
                        host.offerTitle(params.update.title);
                    }

                    channel.push({ kind: 'update', update: params.update });
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
                mcpServers: access ? [{ type: 'stdio', ...access.server }] : [],
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

            // The answer says the message was inserted, not that the turn is over; only a refusal of it ends the turn here.
            listening = true;
            void connection.agent.request(methods.agent.session.prompt, { sessionId: id, prompt: [{ type: 'text', text: `${ preface }${ options.prompt }` } satisfies ContentBlock] }).then(
                () => undefined,
                error => channel.push({ kind: 'failed', error })
            );
            host.promptIs('running');

            // The agent has said `running` (or `requires_action`, as work that starts blocked does) since the prompt went in. ACP makes the agent say
            // so whenever foreground work starts, and an `idle` before it, with a stop reason or without, is a snapshot of the state the session was in
            // ("repeated snapshots may carry the last stop reason"), not the end of this turn.
            let working = false;

            for (;;) {
                const item = await channel.next();

                if (signal.aborted || item.kind === 'aborted') {
                    return;
                }

                if (item.kind === 'update') {
                    const { update } = item;

                    if (SessionUpdate.isUserMessage(update) || SessionUpdate.isUserMessageChunk(update)) {
                        this.echoed.add(update.messageId);
                        this.landing.get(update.messageId)?.();
                        continue;
                    }

                    if (!SessionUpdate.isStateUpdate(update)) {
                        yield* mapper.update(update);
                        continue;
                    }

                    // `requires_action` pauses the turn: the agent waits on a person, the daemon answers its permission requests as they come, and
                    // the turn goes on with `running` or ends with `idle`.
                    if (StateUpdate.isRunning(update) || StateUpdate.isRequiresAction(update)) {
                        working = true;
                    }

                    if (!StateUpdate.isIdle(update) || !working) {
                        continue;
                    }

                    this.over();
                    yield* mapper.stop(update.usage);

                    if (mapper.cost !== undefined) {
                        deps.costs.set(id, mapper.cost);
                    }

                    const failure = IdleStateUpdate.isError(update)
                        ? failureEvent(classifyThrown(update.error ?? new Error(`${ agent.name } stopped with an error`), context, proc.stderr()))
                        : stopFailure(update.stopReason, agent.name);

                    this.answered = !failure;
                    yield failure ?? { type: 'done', result: mapper.result() };

                    return;
                }

                this.over();

                if (item.kind === 'exited') {
                    yield failureEvent(processEnded(context, `exit code ${ proc.child.exitCode ?? 'unknown' }`, proc.stderr()));

                    return;
                }

                yield* mapper.close();
                yield failureEvent(classifyThrown(item.error, context, proc.stderr()));

                return;
            }
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
            this.markEnded();
        }
    }
}
