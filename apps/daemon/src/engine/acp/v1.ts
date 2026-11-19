import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk/unstable';
import { Readable, Writable } from 'node:stream';

import { errorMessage } from '../../errors';
import { answeredInTime, Channel, ProcessEnded, watchEnd } from './connection';
import { applyChoices, isResumeWarning, keepTitle, prefaceOf, stopFailure } from './conversation';
import { classifyThrown, failureEvent, processEnded } from './failure';
import { wait } from './layer';
import { UpdateMapper } from './mapper';

import type { ClientCapabilities, ClientConnection, ContentBlock, NewSessionRequest, PromptResponse, SessionConfigOption, SessionUpdate } from '@agentclientprotocol/sdk/unstable';
import type { EngineEvent } from '../types';
import type { SelectOption } from './conversation';
import type { LayerHost, ProtocolLayer } from './layer';
import type { ResolvedAgent } from './registry';

/** What the client tells an agent it can do in `initialize`. The probe sends the same, so it shows the options a run gets. */
export const clientCapabilities = (agent: Pick<ResolvedAgent, 'clientMeta'>): ClientCapabilities => ({ fs: { readTextFile: false, writeTextFile: false }, terminal: false, ...(agent.clientMeta && { _meta: agent.clientMeta }) });

type Item =
    | { kind: 'update'; update: SessionUpdate }
    | { kind: 'stop'; response: PromptResponse }
    | { kind: 'failed'; error: unknown }
    | { kind: 'exited' }
    | { kind: 'aborted' };

/**
 * The extension both pinned adapters (Claude Code's and Codex's) implement to hand a message to the turn in flight; the SDK has no types for it. An agent
 * that can do it says `_meta.steering.supported` in its answer to `initialize`. `promptRequired` as the idle behaviour makes an agent with no turn running
 * answer so instead of starting a turn of its own that no request of the client owns.
 */
const STEER_METHOD = '_session/steering';

interface SteerRequest {
    sessionId: string;
    prompt: ContentBlock[];
    _meta: { steering: { idleBehavior: 'promptRequired' } };
}

type SteerResponse = { outcome: 'injected' } | { outcome: 'startedNewTurn' } | { outcome: 'promptRequired'; reason?: string };

/** Whether the agent's answer to `initialize` says it can take a steer. */
function canSteer(init: { _meta?: Record<string, unknown> | null }): boolean {
    const steering = init._meta?.steering as { supported?: unknown } | undefined;

    return steering?.supported === true;
}

/**
 * An agent may not have begun the turn of a prompt it has just been sent, and answers a steer then with `promptRequired`. While the prompt is still
 * running the steer is asked again this often, this many times.
 */
const STEER_RETRY_MS = 100;
const STEER_ATTEMPTS = 20;

/** The select options among an agent's, each with its choices (the members of its groups included) in one list. */
function selectsOf(options: SessionConfigOption[] | null | undefined): SelectOption[] {
    return (options ?? []).flatMap(option => option.type === 'select'
        ? [{ id: option.id, category: option.category, currentValue: option.currentValue, choices: option.options.flatMap(choice => 'group' in choice ? choice.options : [choice]) }]
        : []);
}

function isResumeWarningUpdate(update: SessionUpdate): boolean {
    return update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' && isResumeWarning(update.content.text);
}

/**
 * ACP version 1 (the stable protocol): `initialize`, `session/new`, `resume` or `load`, one `session/prompt` that is answered when the turn ends, and the
 * turn's `session/update` notifications in between. The SDK's `client()` carries it.
 */
export class V1Layer implements ProtocolLayer {
    private connection?: ClientConnection;
    private sessionId?: string;
    /** The agent said in `initialize` that it can take a steer. */
    private steerable = false;
    /**
     * The agent said in `initialize` that it names sessions (`sessionCapabilities.title`) and this session is new: it takes a title from the client, and
     * may send one. A session that continues is named already.
     */
    naming = false;
    answered = false;

    constructor(private host: LayerHost) {}

    /** Hands `text` to the turn in flight, through the steering extension; any answer but `injected` leaves the message to the runtime. */
    async steer(text: string): Promise<boolean> {
        const { host, connection, sessionId } = this;

        if (!this.steerable || !connection || !sessionId || host.signal.aborted) {
            return false;
        }

        try {
            for (let attempt = 1; ; attempt++) {
                const answer = await connection.agent.request<SteerResponse, SteerRequest>(STEER_METHOD, {
                    sessionId,
                    prompt: [{ type: 'text', text }],
                    _meta: { steering: { idleBehavior: 'promptRequired' } },
                });

                if (answer?.outcome !== 'promptRequired' || attempt >= STEER_ATTEMPTS) {
                    return answer?.outcome === 'injected';
                }

                await wait(STEER_RETRY_MS);

                if (!host.promptRunning() || host.signal.aborted) {
                    return false;
                }
            }
        }
        catch (error) {
            host.deps.log?.(`${ host.agent.id } refused a steer: ${ errorMessage(error) }`);

            return false;
        }
    }

    cancel(): Promise<void> {
        const { connection, sessionId } = this;

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
        let replaying = false;

        const app = client({ name: 'clowdy' })
            .onNotification(methods.client.session.update, ({ params }) => {
                if (!replaying && params.sessionId === current && !isResumeWarningUpdate(params.update)) {
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
            const init = await answeredInTime(request(connection.agent.request(methods.agent.initialize, {
                protocolVersion: PROTOCOL_VERSION,
                clientCapabilities: clientCapabilities(agent),
                clientInfo: { name: 'clowdy', title: 'Clowdy', version: deps.clientVersion },
            })), host);

            if (init.protocolVersion !== PROTOCOL_VERSION) {
                yield { type: 'error', message: `${ agent.name } speaks ACP version ${ init.protocolVersion }; Clowdy speaks ${ PROTOCOL_VERSION }.`, code: 'invalid_request' };

                return;
            }

            const capabilities = init.agentCapabilities ?? {};

            this.steerable = canSteer(init);

            const access = host.openBridge();
            const supportsSystemPrompt = Boolean(capabilities.sessionCapabilities?.systemPrompt);
            // Only an agent that advertises the field gets it: Grok's `session/resume` refuses a non-empty list. ACP lets the list change on a resume
            // while `cwd` stays, so a folder added between turns keeps the session. Not in `_meta.claudeCode.options` as well: Claude's adapter
            // would add the folders a second time.
            const directories = capabilities.sessionCapabilities?.additionalDirectories ? options.additionalDirectories ?? [] : [];
            const shared: NewSessionRequest = {
                cwd: options.cwd,
                mcpServers: access ? [access.server] : [],
                ...(directories.length > 0 && { additionalDirectories: directories }),
                ...(agent.sessionMeta && { _meta: agent.sessionMeta }),
                ...(supportsSystemPrompt && options.systemPrompt && { systemPrompt: { mode: 'append', content: [{ type: 'text', text: options.systemPrompt }] } }),
            };

            let configOptions: SessionConfigOption[] | null | undefined;
            let resumed = false;

            if (options.resumeSessionId) {
                const id = options.resumeSessionId;

                try {
                    if (capabilities.sessionCapabilities?.resume) {
                        configOptions = (await request(connection.agent.request(methods.agent.session.resume, { sessionId: id, ...shared }))).configOptions;
                        resumed = true;
                    }
                    else if (capabilities.loadSession) {
                        // The agent replays the whole conversation as updates before it answers; none of it is news.
                        replaying = true;
                        current = id;

                        try {
                            configOptions = (await request(connection.agent.request(methods.agent.session.load, { sessionId: id, ...shared }))).configOptions;
                        }
                        finally {
                            replaying = false;
                        }

                        resumed = true;
                    }
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

            this.naming = Boolean(capabilities.sessionCapabilities?.title) && !resumed;
            this.sessionId = id;
            yield { type: 'session', sessionId: id };

            await applyChoices({
                agent: agent.name,
                options: selectsOf(configOptions),
                model: options.model,
                effort: options.effort,
                set: async ({ configId, value }) => {
                    const answer = await request(connection.agent.request(methods.agent.session.setConfigOption, { sessionId: id, configId, value }));

                    return answer.configOptions ? selectsOf(answer.configOptions) : undefined;
                },
            });

            await keepTitle({ agent: agent.name, signal, title: options.title, naming: this.naming }, keep => request(connection.agent.request(methods.agent.session.setTitle, { sessionId: id, title: keep })));

            // An agent that was to continue a conversation and starts a new one has not seen it: it is told what it said, so the work is not lost.
            const record = options.resumeSessionId && !resumed ? host.record() : undefined;

            // An agent that cannot take a system prompt gets it in front of the first message of a conversation it has not seen.
            const preface = prefaceOf({ systemPrompt: options.systemPrompt, supportsSystemPrompt, resumed, record });

            const mapper = new UpdateMapper({ toolNames: options.tools.map(tool => tool.name), costBefore: deps.costs.get(id), log: deps.log });

            void connection.agent.request(methods.agent.session.prompt, { sessionId: id, prompt: [{ type: 'text', text: `${ preface }${ options.prompt }` } satisfies ContentBlock] }).then(
                response => channel.push({ kind: 'stop', response }),
                error => channel.push({ kind: 'failed', error })
            );
            host.promptIs('running');

            for (;;) {
                const item = await channel.next();

                if (signal.aborted || item.kind === 'aborted') {
                    return;
                }

                if (item.kind === 'update') {
                    yield* mapper.update(item.update);
                    continue;
                }

                // Whatever ended it, the prompt takes no steer any more.
                host.promptIs('over');

                if (item.kind === 'exited') {
                    yield failureEvent(processEnded(context, `exit code ${ proc.child.exitCode ?? 'unknown' }`, proc.stderr()));

                    return;
                }

                if (item.kind === 'failed') {
                    yield* mapper.close();
                    yield failureEvent(classifyThrown(item.error, context, proc.stderr()));

                    return;
                }

                yield* mapper.stop(item.response);

                if (mapper.cost !== undefined) {
                    deps.costs.set(id, mapper.cost);
                }

                const failure = stopFailure(item.response.stopReason, agent.name);

                this.answered = !failure;
                yield failure ?? { type: 'done', result: mapper.result() };

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
    }
}
