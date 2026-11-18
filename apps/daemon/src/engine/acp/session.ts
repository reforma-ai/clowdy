import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk/unstable';
import { Readable, Writable } from 'node:stream';

import { errorMessage } from '../../errors';
import { spawnInOwnGroup } from '../process';
import { buildAgentEnv } from './env';
import { classifyFailure, classifyThrown, processEnded } from './failure';
import { UpdateMapper } from './mapper';

import type { ClientConnection, ContentBlock, NewSessionRequest, PromptResponse, RequestPermissionRequest, RequestPermissionResponse, SessionConfigOption, SessionUpdate } from '@agentclientprotocol/sdk/unstable';
import type { AgentProcess } from '../process';
import type { EngineEvent, EngineSession, EngineStartOptions } from '../types';
import type { BridgeAccess, ToolBridge } from './bridge';
import type { Failure } from './failure';
import type { AgentRegistry, ResolvedAgent } from './registry';

/** How long `close()` waits for the agent's process to be gone. */
const CLOSE_WAIT_MS = 10_000;

/** After `session/cancel` and a closed input, the agent has this long to leave by itself before its group is stopped. */
const CANCEL_GRACE_MS = 1000;

/**
 * How long a program may take to answer `initialize`. A command that is not an ACP agent never does, and the first start
 * of an adapter fetched with `bun x` can be slow, so the bound is generous.
 */
const INITIALIZE_TIMEOUT_MS = 120_000;

type Env = Record<string, string | undefined>;

/** How the daemon answers `session/request_permission`: nobody is at a terminal, so it decides for every agent alike. */
export type PermissionPolicy = 'allow' | 'reject';

export interface SessionDeps {
    agentId: string;
    registry: AgentRegistry;
    bridge: ToolBridge;
    /** The daemon's own environment, which the agent's is built from. */
    env: Env;
    permissions: PermissionPolicy;
    /** The session's cumulative cost in USD as of its last prompt, kept in memory per session id (the agent reports totals). */
    costs: Map<string, number>;
    clientVersion: string;
    /** How long to wait for the agent's answer to `initialize`; two minutes by default. */
    initializeTimeoutMs?: number;
    log?: (line: string) => void;
}

/** An unbounded queue read with `await next()`. */
class Channel<T> {
    private items: T[] = [];
    private waiting?: (item: T) => void;

    push(item: T): void {
        if (this.waiting) {
            const resolve = this.waiting;

            this.waiting = undefined;
            resolve(item);
        }
        else {
            this.items.push(item);
        }
    }

    next(): Promise<T> {
        const item = this.items.shift();

        return item !== undefined ? Promise.resolve(item) : new Promise<T>((resolve) => {
            this.waiting = resolve;
        });
    }
}

type Item =
    | { kind: 'update'; update: SessionUpdate }
    | { kind: 'stop'; response: PromptResponse }
    | { kind: 'failed'; error: unknown }
    | { kind: 'exited' }
    | { kind: 'aborted' };

/** The process went away while the session still needed it. */
class ProcessEnded extends Error {}

const wait = (ms: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
});

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>;

/** The select options of one category: `model` picks the model, `thought_level` the reasoning level. */
function selectsOf(options: SessionConfigOption[] | null | undefined, category: string): SelectOption[] {
    return (options ?? []).filter((option): option is SelectOption => option.category === category && option.type === 'select');
}

/** What to send to set an option: its id and the value, or nothing when the option is already on it. */
interface ConfigChange {
    configId: string;
    value: string;
    /** The option is on this value already, so there is nothing to send. */
    unchanged: boolean;
}

/** The choice of `option` called `wanted`, by value or by name, case-insensitive; groups are flattened. */
function changeTo(option: SelectOption, wanted: string): ConfigChange | undefined {
    const lower = wanted.toLowerCase();
    const choices = option.options.flatMap(choice => 'group' in choice ? choice.options : [choice]);
    const match = choices.find(choice => choice.value.toLowerCase() === lower) ?? choices.find(choice => choice.name.toLowerCase() === lower);

    return match && { configId: option.id, value: match.value, unchanged: option.currentValue === match.value };
}

/** The id of the option that picks the model, and the value of `model` among its choices (by value or by name). */
function modelChoice(options: SessionConfigOption[] | null | undefined, model: string): ConfigChange | undefined {
    const [option] = selectsOf(options, 'model');

    return option && changeTo(option, model);
}

/**
 * The reasoning option that has a choice called `effort`. An agent names it as it likes (Claude `effort`, Codex `reasoning_effort`, one of
 * Cursor's several per model), and a model may carry other `thought_level` options with other values (Cursor's `thinking`), so the option is
 * found by the value it offers. Call it on the options the agent reported after the model was set: a model decides which levels exist.
 */
function effortChoice(options: SessionConfigOption[] | null | undefined, effort: string): ConfigChange | undefined {
    for (const option of selectsOf(options, 'thought_level')) {
        const change = changeTo(option, effort);

        if (change) {
            return change;
        }
    }

    return undefined;
}

/**
 * Codex warns, as an assistant message right after it resumes a session, that the session was recorded with another model than the one
 * it resumes with. Clowdy resumes on the person's own settings and changes the model to the chat's before the prompt, so the warning is noise.
 */
const RESUME_WARNING = /^Warning: This session was recorded with model /;

function isResumeWarning(update: SessionUpdate): boolean {
    return update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' && RESUME_WARNING.test(update.content.text);
}

/**
 * One agent process driven over ACP for one turn of a run, plus any messages sent into it meanwhile. The turn is a
 * `session/prompt`; text sent while it runs waits and goes out as the next prompt, and the session reports `done` when
 * nothing is left to say.
 */
export class AcpSession implements EngineSession {
    private inbox: string[] = [];
    private closing = new AbortController();
    private signal: AbortSignal;
    private exited: Promise<void> = Promise.resolve();
    private connection?: ClientConnection;
    private sessionId?: string;
    private access?: BridgeAccess;

    constructor(private options: EngineStartOptions, private deps: SessionDeps) {
        this.signal = AbortSignal.any([options.signal, this.closing.signal]);
        this.inbox.push(options.prompt);
    }

    send(text: string): void {
        this.inbox.push(text);
    }

    /** The conversation so far, when the runtime can tell it; a record that cannot be made leaves the turn as it is. */
    private record(): string | undefined {
        try {
            return this.options.history?.();
        }
        catch (error) {
            console.warn(`[clowdy] could not write down the earlier conversation for a new session: ${ errorMessage(error) }`);

            return undefined;
        }
    }

    /** Stops the session and waits until its process is gone. */
    async close(): Promise<void> {
        this.closing.abort();
        // The token is useless once the session is over, even when nobody reads the generator to its end.
        this.access?.dispose();
        await Promise.race([this.exited, wait(CLOSE_WAIT_MS)]);
    }

    [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
        return this.run();
    }

    private failure(failure: Failure): EngineEvent {
        return { type: 'error', message: failure.message, retryable: failure.retryable, code: failure.code };
    }

    private async *run(): AsyncGenerator<EngineEvent> {
        if (this.signal.aborted) {
            return;
        }

        const { registry, agentId } = this.deps;
        const resolution = await registry.resolve(agentId);

        if (!resolution.ok) {
            yield { type: 'error', message: resolution.message, code: 'engine_missing' };

            return;
        }

        const { agent } = resolution;
        let proc: AgentProcess;

        try {
            const path = await registry.path();

            // Looking for the program can take a while (the first time it asks the login shell); a run cancelled meanwhile starts nothing.
            if (this.signal.aborted) {
                return;
            }

            proc = await spawnInOwnGroup({
                command: agent.command,
                args: agent.args,
                cwd: this.options.cwd,
                env: buildAgentEnv({ daemonEnv: this.deps.env, path, scrub: agent.scrub, set: agent.env }),
            });
        }
        catch (error) {
            yield this.failure(classifyThrown(error, { agent: agent.name, login: agent.login }));

            return;
        }

        this.exited = proc.exited;

        let stopping = false;

        // Cancelled: tell the agent (the cancel has to be written before the input closes), let it leave by itself for a
        // moment, then stop its whole group.
        const stopAgent = () => {
            if (stopping) {
                return;
            }

            stopping = true;

            const { connection, sessionId } = this;
            const told = connection && sessionId ? connection.agent.notify(methods.agent.session.cancel, { sessionId }).catch(() => undefined) : Promise.resolve();

            void told.then(() => {
                proc.child.stdin?.end();

                return Promise.race([proc.exited, wait(CANCEL_GRACE_MS)]);
            }).then(() => proc.stop());
        };

        this.signal.addEventListener('abort', stopAgent, { once: true });

        // Cancelled while the agent was starting, before there was anybody to hear it.
        if (this.signal.aborted) {
            stopAgent();
        }

        try {
            // Inside the `try`: a reader that stops here must not leave the process behind.
            yield { type: 'process', pid: proc.pid, ...(process.platform !== 'win32' && { pgid: proc.pid }), startedAt: Date.now() };

            if (this.signal.aborted) {
                return;
            }

            yield* this.talk(agent, proc);
        }
        finally {
            this.signal.removeEventListener('abort', stopAgent);
            this.access?.dispose();

            // A cancelled run is stopped by `stopAgent`, which gives the agent its moment first.
            if (!this.signal.aborted) {
                proc.stop();
            }

            void proc.exited.then(() => this.connection?.close());
        }
    }

    /** The conversation with a running agent, from `initialize` to the last event of the turn. */
    private async *talk(agent: ResolvedAgent, proc: AgentProcess): AsyncGenerator<EngineEvent> {
        const { deps, options, signal } = this;
        const context = { agent: agent.name, login: agent.login };
        const channel = new Channel<Item>();
        let current: string | undefined;
        let replaying = false;

        const app = client({ name: 'clowdy' })
            .onNotification(methods.client.session.update, ({ params }) => {
                if (!replaying && params.sessionId === current && !isResumeWarning(params.update)) {
                    channel.push({ kind: 'update', update: params.update });
                }
            })
            .onRequest(methods.client.session.requestPermission, ({ params }) => this.permission(params));

        const input = Readable.toWeb(proc.child.stdout as Readable) as ReadableStream<Uint8Array>;
        const output = Writable.toWeb(proc.child.stdin as Writable) as WritableStream<Uint8Array>;
        const connection = app.connect(ndJsonStream(output, input));

        this.connection = connection;

        // Something that rejects when the process goes away or the run is cancelled, to race against requests that would wait forever.
        // Either also wakes the loop that waits for the agent's next word, so a cancelled session ends at once.
        const gone = new Promise<never>((_, reject) => {
            void proc.exited.then(() => {
                channel.push({ kind: 'exited' });
                reject(new ProcessEnded());
            });
            signal.addEventListener('abort', () => {
                channel.push({ kind: 'aborted' });
                reject(signal.reason ?? new Error('aborted'));
            }, { once: true });
        });

        gone.catch(() => undefined);

        const request = <T>(call: Promise<T>): Promise<T> => Promise.race([call, gone]);

        try {
            const initializeMs = deps.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const silent = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    const tail = proc.stderr().trim().slice(-500);

                    reject(new Error(`${ agent.name } did not answer the ACP handshake in ${ Math.max(1, Math.round(initializeMs / 1000)) } s. Check that the command speaks ACP.${ tail ? ` Last output: ${ tail }` : '' }`));
                }, initializeMs);
            });

            silent.catch(() => undefined);

            const init = await Promise.race([
                request(connection.agent.request(methods.agent.initialize, {
                    protocolVersion: PROTOCOL_VERSION,
                    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, ...(agent.clientMeta && { _meta: agent.clientMeta }) },
                    clientInfo: { name: 'clowdy', title: 'Clowdy', version: deps.clientVersion },
                })),
                silent,
            ]).finally(() => clearTimeout(timer));

            if (init.protocolVersion !== PROTOCOL_VERSION) {
                yield { type: 'error', message: `${ agent.name } speaks ACP version ${ init.protocolVersion }; Clowdy speaks ${ PROTOCOL_VERSION }.`, code: 'invalid_request' };

                return;
            }

            const capabilities = init.agentCapabilities ?? {};
            const access = options.tools.length > 0 ? deps.bridge.register(options.tools, signal) : undefined;

            this.access = access;

            const supportsSystemPrompt = Boolean(capabilities.sessionCapabilities?.systemPrompt);
            const shared: NewSessionRequest = {
                cwd: options.cwd,
                mcpServers: access ? [access.server] : [],
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

            this.sessionId = id;
            yield { type: 'session', sessionId: id };

            // The model first: it decides which levels the agent offers, and the answer to a change lists the options as they are now.
            if (options.model) {
                const choice = modelChoice(configOptions, options.model);

                if (!choice) {
                    console.warn(`[clowdy] ${ agent.name } offers no model called "${ options.model }"; it keeps its own choice`);
                }
                else if (!choice.unchanged) {
                    const answer = await request(connection.agent.request(methods.agent.session.setConfigOption, { sessionId: id, configId: choice.configId, value: choice.value }));

                    configOptions = answer.configOptions ?? configOptions;
                }
            }

            if (options.effort) {
                const choice = effortChoice(configOptions, options.effort);

                if (!choice) {
                    console.warn(`[clowdy] ${ agent.name } offers no reasoning level called "${ options.effort }"${ options.model ? ` for ${ options.model }` : '' }; it keeps its own choice`);
                }
                else if (!choice.unchanged) {
                    await request(connection.agent.request(methods.agent.session.setConfigOption, { sessionId: id, configId: choice.configId, value: choice.value }));
                }
            }

            // An agent that was to continue a conversation and starts a new one has not seen it: it is told what it said, so the work is not lost.
            const record = options.resumeSessionId && !resumed ? this.record() : undefined;

            // An agent that cannot take a system prompt gets it in front of the first message of a conversation it has not seen.
            let preface = [
                !supportsSystemPrompt && !resumed && options.systemPrompt,
                record,
            ].filter(Boolean).map(part => `${ part }\n\n---\n\n`).join('');

            for (;;) {
                const text = `${ preface }${ this.inbox.splice(0).join('\n\n') }`;
                const mapper = new UpdateMapper({ toolNames: options.tools.map(tool => tool.name), costBefore: deps.costs.get(id), log: deps.log });

                preface = '';
                void connection.agent.request(methods.agent.session.prompt, { sessionId: id, prompt: [{ type: 'text', text } satisfies ContentBlock] }).then(
                    response => channel.push({ kind: 'stop', response }),
                    error => channel.push({ kind: 'failed', error })
                );

                for (;;) {
                    const item = await channel.next();

                    if (signal.aborted || item.kind === 'aborted') {
                        return;
                    }

                    if (item.kind === 'update') {
                        yield* mapper.update(item.update);
                    }
                    else if (item.kind === 'exited') {
                        yield this.failure(processEnded(context, `exit code ${ proc.child.exitCode ?? 'unknown' }`, proc.stderr()));

                        return;
                    }
                    else if (item.kind === 'failed') {
                        yield* mapper.close();
                        yield this.failure(classifyThrown(item.error, context, proc.stderr()));

                        return;
                    }
                    else {
                        yield* mapper.stop(item.response);

                        if (mapper.cost !== undefined) {
                            deps.costs.set(id, mapper.cost);
                        }

                        const failed = this.stopFailure(item.response.stopReason, agent.name);

                        if (failed) {
                            yield failed;

                            return;
                        }

                        if (this.inbox.length > 0) {
                            break;
                        }

                        yield { type: 'done', result: mapper.result() };

                        return;
                    }
                }
            }
        }
        catch (error) {
            if (signal.aborted) {
                return;
            }

            if (error instanceof ProcessEnded) {
                yield this.failure(processEnded(context, `exit code ${ proc.child.exitCode ?? 'unknown' }`, proc.stderr()));

                return;
            }

            yield this.failure(classifyThrown(error, context, proc.stderr()));
        }
    }

    /** What the daemon answers when the agent asks for permission. */
    private permission(request: RequestPermissionRequest): RequestPermissionResponse {
        const wanted = this.deps.permissions === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];

        for (const kind of wanted) {
            const option = request.options.find(candidate => candidate.kind === kind);

            if (option) {
                return { outcome: { outcome: 'selected', optionId: option.optionId } };
            }
        }

        return { outcome: { outcome: 'cancelled' } };
    }

    /** A prompt can end for a reason that is not a finished answer. */
    private stopFailure(reason: string, agent: string): EngineEvent | undefined {
        switch (reason) {
            case 'max_tokens':
                return { type: 'error', message: `${ agent } stopped because it reached the limit on the length of an answer.`, code: 'unknown' };
            case 'max_turn_requests':
                return { type: 'error', message: `${ agent } stopped because it reached its limit on steps in one turn.`, code: 'unknown' };
            case 'refusal':
                return this.failure(classifyFailure({ agent, text: 'The agent declined the request', kind: 'invalid_request' }));
            default:
                return undefined;
        }
    }
}
