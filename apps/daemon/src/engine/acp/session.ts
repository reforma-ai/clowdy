import { errorMessage } from '../../errors';
import { spawnInOwnGroup } from '../process';
import { buildAgentEnv } from './env';
import { classifyThrown, failureEvent } from './failure';
import { wait } from './layer';
import { V1Layer } from './v1';
import { V2Layer } from './v2';

import type { AgentProcess } from '../process';
import type { EngineEvent, EngineSession, EngineStartOptions } from '../types';
import type { BridgeAccess, ToolBridge } from './bridge';
import type { AgentProtocol } from './catalog';
import type { LayerHost, PromptState, ProtocolLayer } from './layer';
import type { AgentRegistry, ResolvedAgent } from './registry';

/** How long `close()` waits for the agent's process to be gone. */
const CLOSE_WAIT_MS = 10_000;

/**
 * How long an agent that has not named its session by the end of the turn keeps running for the name. Codex names a session after the turn is over,
 * about five seconds on, with a call to a small model.
 */
const TITLE_WAIT_MS = 10_000;

/** After `session/cancel` and a closed input, the agent has this long to leave by itself before its group is stopped. */
const CANCEL_GRACE_MS = 1000;

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
    /**
     * The agents that were asked for ACP v2 and answered with version 1 or refused the handshake, by launch (`launchKey`): they are spoken to in v1 from
     * then on, for the life of the daemon. The engine owns it, so every session of an agent shares what the first one learned.
     */
    downgraded: Set<string>;
    /** How long to wait for the agent's answer to `initialize`; two minutes by default. */
    initializeTimeoutMs?: number;
    /** How long an agent that has not named its session by the end of the turn keeps running for the name; ten seconds by default. */
    titleWaitMs?: number;
    /** How long a session with nothing open waits for the agent to begin a turn before it ends (`BACKGROUND_HANDOFF_MS`, two seconds by default). */
    backgroundHandoffMs?: number;
    /** The same when the agent owes the report of work that just ended (`BACKGROUND_REPORT_MS`, twenty seconds by default; `backgroundHandoffMs` when only that is set). */
    backgroundReportMs?: number;
    log?: (line: string) => void;
}

/** The layer that speaks each protocol. */
const LAYERS: Record<AgentProtocol, new (host: LayerHost) => ProtocolLayer> = {
    v1: V1Layer,
    v2: V2Layer,
};

/**
 * What tells one program of an agent from another, for the memory of which ones speak v1 only: the program it drives and the command with its
 * arguments, which carry an adapter's pinned version, so a new pin is tried on v2 again.
 */
const launchKey = (agent: ResolvedAgent): string => [agent.program, agent.command, ...agent.args].join('\0');

/**
 * One agent process driven over ACP for one turn of a run: one `session/prompt`, and `done` when the agent's turn ends. A message the person writes
 * meanwhile reaches the turn only as a steer (`steer`), when the agent can take one; the runtime keeps any other for the next turn. The session owns
 * the process and what every protocol shares; the conversation is a layer for the agent's protocol (`layer.ts`).
 *
 * A session outlives its turn in two ways. A layer whose agent has background work open keeps its iterator going (the process stays recorded on the
 * run for the whole wait), reads the turns the agent starts on its own, and takes `send`; the layer ends when nothing is open, and with it the process.
 * After that, a new session whose title the runtime still waits for keeps the process for the name, up to `titleWaitMs` (`linger`), unrecorded.
 */
export class AcpSession implements EngineSession {
    private closing = new AbortController();
    private signal: AbortSignal;
    private exited: Promise<void> = Promise.resolve();
    private layer?: ProtocolLayer;
    /** The agent the session resolved, once it has. */
    private agent?: ResolvedAgent;
    private access?: BridgeAccess;
    private prompt: PromptState = 'before';
    /** The session is over for good: its process is to be stopped or gone, and no turn will begin. Until then a layer may open the prompt again with each turn. */
    private finished = false;
    /** Wake the steers that wait for the prompt to be with the agent (or for the session to end before it is). */
    private promptWaiters: (() => void)[] = [];
    /** The runtime took a title the agent gave. */
    private titled = false;
    private tookTitle: () => void = () => undefined;
    private titleTaken = new Promise<void>((resolve) => {
        this.tookTitle = resolve;
    });
    /** The turn is over and the agent runs on for its title; `close()` leaves it to leave by itself. */
    private lingering = false;

    constructor(private options: EngineStartOptions, private deps: SessionDeps) {
        this.signal = AbortSignal.any([options.signal, this.closing.signal]);
    }

    /**
     * Hands `text` to the turn in flight. A steer that comes while the agent is still starting waits until the prompt is with it, since a steer is only
     * taken by a turn that runs; an agent that did not say it can steer, a prompt that is over, or an answer that is not `injected` leaves the message to
     * the runtime, which keeps it for the next turn.
     */
    async steer(text: string): Promise<boolean> {
        if (this.prompt === 'before') {
            await new Promise<void>(resolve => this.promptWaiters.push(resolve));
        }

        const { layer } = this;

        if (this.prompt !== 'running' || !layer || this.signal.aborted) {
            return false;
        }

        return layer.steer(text);
    }

    /**
     * Puts `text` to the live session as a prompt of its own, for an agent that keeps the session open while it has background work: its turn ended
     * (`done`) and the iterator is still being read. Answers whether the agent took it, and never waits for the iterator to be read; the session being
     * over (closed, cancelled, ended, or its process gone), or a layer that cannot, answers `false`, and the runtime resumes the conversation in a
     * session of its own instead. One `done` follows an accepted prompt.
     */
    async send(text: string): Promise<boolean> {
        const { layer } = this;

        if (this.finished || this.signal.aborted || !layer?.send) {
            return false;
        }

        return layer.send(text);
    }

    /**
     * Asks the agent to end one sub-agent it announced, or one background command it lists, and leave everything else running. Answers whether the agent
     * took the request: a session that is over, a layer whose protocol has no such request (v1), and a sub-agent or command the layer does not know as open
     * answer `false`.
     */
    async stopItem(id: string): Promise<boolean> {
        const { layer } = this;

        if (this.finished || this.signal.aborted || !layer?.stopItem) {
            return false;
        }

        return layer.stopItem(id);
    }

    /** Whether the agent leaves it to the runtime to tell it that background work ended (`AgentSpec.wakesOnBackgroundEnd`). */
    get wakesOnBackgroundEnd(): boolean {
        return this.agent?.wakesOnBackgroundEnd === true;
    }

    /** Whether the agent can take a steer at all: what its handshake said, and until then, or over v2, that it can. */
    get canSteer(): boolean {
        return this.layer?.canSteer ?? true;
    }

    /**
     * Moves the prompt along and wakes the steers that wait for it. A layer that keeps the session open opens the prompt again with each turn that
     * begins, so a steer finds the turn that runs now; a session that is over (`finish`) stays over.
     */
    private promptIs(state: Exclude<PromptState, 'before'>): void {
        if (this.finished) {
            return;
        }

        this.prompt = state;

        for (const wake of this.promptWaiters.splice(0)) {
            wake();
        }
    }

    /** The session is over for good, whatever ended it: no prompt will be with the agent again, and a steer that still waits for one waits for nothing. */
    private finish(): void {
        this.finished = true;
        this.prompt = 'over';

        for (const wake of this.promptWaiters.splice(0)) {
            wake();
        }
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

    /** Stops the session and waits until its process is gone, except one that runs on for its title: that leaves by itself, so the run does not wait for it. */
    async close(): Promise<void> {
        this.closing.abort();
        this.finish();
        // The token is useless once the session is over, even when nobody reads the generator to its end.
        this.access?.dispose();

        if (this.lingering) {
            return;
        }

        await Promise.race([this.exited, wait(CLOSE_WAIT_MS)]);
    }

    /** Passes a title the agent gave to the runtime, which says whether it took it; the first one it takes ends the wait for a title. */
    private offerTitle(text: string): void {
        const { title } = this.options;

        if (!title || !('onTitle' in title) || this.titled) {
            return;
        }

        try {
            if (title.onTitle(text)) {
                this.titled = true;
                this.tookTitle();
            }
        }
        catch (error) {
            console.warn(`[clowdy] the title ${ JSON.stringify(text) } was not taken: ${ errorMessage(error) }`);
        }
    }

    /** Whether a turn that is over leaves the agent running: the runtime wants a title, the agent names this new session and has not yet. */
    private awaitsTitle(): boolean {
        const { layer } = this;
        const { title } = this.options;

        return Boolean(layer?.answered && layer.naming && !this.titled && title && 'onTitle' in title);
    }

    /** Keeps the agent running until the runtime took its title, the time is up, the signal of the turn is aborted (a cancel, the daemon stopping) or the agent leaves; then stops it. */
    private async linger(proc: AgentProcess): Promise<void> {
        const { signal } = this.options;
        const cancelled = new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
        });

        try {
            await Promise.race([this.titleTaken, cancelled, proc.exited, wait(this.deps.titleWaitMs ?? TITLE_WAIT_MS)]);
        }
        finally {
            proc.stop();
        }
    }

    [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
        return this.run();
    }

    private async *run(): AsyncGenerator<EngineEvent> {
        try {
            yield* this.drive();
        }
        finally {
            // However the session ended, a steer that still waits for the prompt waits for nothing.
            this.finish();
        }
    }

    private async *drive(): AsyncGenerator<EngineEvent> {
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

        this.agent = agent;

        const key = launchKey(agent);
        let protocol: AgentProtocol = agent.protocol === 'v2' && !this.deps.downgraded.has(key) ? 'v2' : 'v1';

        // An agent asked for v2 that answers with version 1, or refuses the handshake, is started again on v1, once, and remembered. The attempt that
        // found out told the runtime nothing but its process, which the next attempt's replaces.
        for (;;) {
            const next = yield* this.attempt(agent, protocol);

            if (next === undefined || this.signal.aborted) {
                return;
            }

            this.deps.downgraded.add(key);
            protocol = next;
        }
    }

    /** One start of the agent's process and its conversation. Gives back the protocol to start the agent on again, when the handshake showed it speaks another. */
    private async *attempt(agent: ResolvedAgent, protocol: AgentProtocol): AsyncGenerator<EngineEvent, AgentProtocol | undefined> {
        const { registry } = this.deps;
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
            yield failureEvent(classifyThrown(error, { agent: agent.name, login: agent.login }));

            return;
        }

        this.exited = proc.exited;

        const layer = this.startLayer(agent, proc, protocol);
        let restart: AgentProtocol | undefined;
        let stopping = false;

        // Cancelled: tell the agent (the cancel has to be written before the input closes), let it leave by itself for a
        // moment, then stop its whole group.
        const stopAgent = () => {
            if (stopping) {
                return;
            }

            stopping = true;
            // The agent may leave by itself as soon as its input closes, and what it started in groups of their own would then belong to nobody.
            proc.watch();

            void layer.cancel().then(() => {
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

            yield* layer.run();
            restart = layer.restartOn;
        }
        finally {
            this.signal.removeEventListener('abort', stopAgent);
            this.access?.dispose();

            // A cancelled run is stopped by `stopAgent`, which gives the agent its moment first.
            if (!this.signal.aborted) {
                if (this.awaitsTitle()) {
                    this.lingering = true;
                    void this.linger(proc);
                }
                else {
                    proc.stop();
                }
            }

            void proc.exited.then(() => layer.disconnect());
        }

        // The next attempt starts when this process is gone, not beside it.
        if (restart) {
            await proc.exited;
        }

        return restart;
    }

    /** The layer for the agent's protocol, with what the session lends it. */
    private startLayer(agent: ResolvedAgent, proc: AgentProcess, protocol: AgentProtocol): ProtocolLayer {
        const { options, deps, signal } = this;

        const layer = new LAYERS[protocol]({
            agent,
            proc,
            options,
            signal,
            deps,
            openBridge: () => {
                this.access = options.tools.length > 0 ? deps.bridge.register(options.tools, signal) : undefined;

                return this.access;
            },
            offerTitle: title => this.offerTitle(title),
            pickPermission: choices => this.pickPermission(choices),
            promptIs: state => this.promptIs(state),
            promptRunning: () => this.prompt === 'running',
            record: () => this.record(),
        });

        this.layer = layer;

        return layer;
    }

    /** What the daemon answers when the agent asks for permission: the first option of the kinds its policy takes. */
    private pickPermission(choices: readonly { optionId: string; kind: string }[]): string | undefined {
        const wanted = this.deps.permissions === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];

        for (const kind of wanted) {
            const option = choices.find(candidate => candidate.kind === kind);

            if (option) {
                return option.optionId;
            }
        }

        return undefined;
    }
}
