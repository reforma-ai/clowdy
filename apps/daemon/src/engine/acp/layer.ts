import type { AgentProcess } from '../process';
import type { EngineEvent, EngineStartOptions } from '../types';
import type { BridgeAccess } from './bridge';
import type { AgentProtocol } from './catalog';
import type { ResolvedAgent } from './registry';
import type { SessionDeps } from './session';

/**
 * Where the session's prompt is: not sent yet, with the agent (a turn runs), or answered (the turn is over, or the session ended before it was sent). A
 * layer that keeps the session open moves it to `running` again with each turn that begins, a turn the agent starts on its own or one a prompt sent
 * into the live session leads to; the end of the session is for good.
 */
export type PromptState = 'before' | 'running' | 'over';

/**
 * How long a session with nothing open and no turn running waits before it ends, when a turn of its own has just ended: the agent may begin another
 * one at once (the turn a landed steer leads to, which comes within milliseconds). A session closed the moment nothing is open would lose it.
 */
export const BACKGROUND_HANDOFF_MS = 2000;

/**
 * How long it waits when the last background work has just finished while no turn ran: the agent owes the report of it. Claude's adapter says
 * `running` for that turn only when the model's first output arrives, which took 0.75 to 1.7 s in thirteen samples and more than 2 s in one, whose
 * report a two-second guard lost (`.briefback/background-work/research/acp-background-probe.md`, "Real check through the daemon"). No marker comes
 * before that output, so this is a bound on a slow model call, not a measure of one; a session whose agent never reports ends after it.
 */
export const BACKGROUND_REPORT_MS = 20_000;

export const wait = (ms: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
});

/**
 * What the session that owns an agent's process gives the layer that speaks ACP to it. The session spawns and stops the process and keeps what every
 * protocol shares (the tool bridge, the answers to permission requests, the title the runtime takes); the layer writes the conversation on the
 * process's streams.
 */
export interface LayerHost {
    agent: ResolvedAgent;
    proc: AgentProcess;
    options: EngineStartOptions;
    /** Aborted when the turn's own signal is or the session is closed. The layer ends at once; stopping the process is the session's. */
    signal: AbortSignal;
    deps: Pick<SessionDeps, 'costs' | 'clientVersion' | 'initializeTimeoutMs' | 'backgroundHandoffMs' | 'backgroundReportMs' | 'log'>;
    /** Registers the runtime's tools with the bridge, once the agent has shaken hands, and gives back the MCP server to name in the session. `undefined` when the run has none. */
    openBridge(): BridgeAccess | undefined;
    /** Passes a title the agent gave to the runtime, which says whether it took it. */
    offerTitle(title: string): void;
    /** The option of a permission request the daemon answers with, or `undefined` to cancel the request. */
    pickPermission(options: readonly { optionId: string; kind: string }[]): string | undefined;
    /** Moves the prompt along and wakes the steers that wait for it. A turn that begins after the last one ended moves it to `running` again. */
    promptIs(state: Exclude<PromptState, 'before'>): void;
    /** Whether the prompt is with the agent. */
    promptRunning(): boolean;
    /** The conversation so far, to put before the prompt of a session that replaces one that could not be continued. */
    record(): string | undefined;
}

/**
 * One protocol's conversation with a running agent: its handshake, its session calls, its turn. A layer is made for one connection (one process) and
 * touches the process's streams only when `run` is read.
 */
export interface ProtocolLayer {
    /** The agent names this new session itself, so it may send a title after the turn. Known once the session is open. */
    readonly naming: boolean;
    /** The turn ended with an answer, not a failure. */
    readonly answered: boolean;
    /** Whether the agent can take a steer at all, once its handshake has told; absent while it has not, and for a protocol whose agents always can (v2). */
    readonly canSteer?: boolean;
    /**
     * Set when `run` ended without a single event because the handshake showed that the agent speaks another protocol than this layer's (a v2 layer
     * that was answered with version 1, or refused). The session stops the process and starts the agent again on that protocol. A layer that sets it has
     * done nothing the runtime could see: no session, no tool bridge, no title taken.
     */
    readonly restartOn?: AgentProtocol;
    /** The conversation, from the handshake to the last event of the turn. It does not throw: a failure is an `error` event. */
    run(): AsyncGenerator<EngineEvent>;
    /** Hands `text` to the turn in flight. Answers whether the agent took it. Called while the prompt is with the agent. */
    steer(text: string): Promise<boolean>;
    /**
     * Hands `text` to the live session as a prompt of its own, once its turn ended. A layer that keeps the session open for the agent's background work
     * takes it, and leaves it out when it cannot. Resolves `true` when the agent took the prompt in; its events follow on the stream of `run`, with one
     * `done` for the whole activity, and `false` when the session is over or the agent refused it. It never waits for the events to be read.
     */
    send?(text: string): Promise<boolean>;
    /**
     * Asks the agent to end one thing it has open and nothing else: a sub-agent (`id` is the id its `subagent` event had) or a background command (`id` is the
     * id of its `background` item). The session and everything else it has open go on. Resolves `true` when the agent took the request (a sub-agent's is a
     * notification, written; a command's is a request the agent answers), `false` when the layer did not send it or the agent refused it (the conversation is over,
     * the thing is unknown or has ended, or the agent did not say it can be ended). The end itself comes on the stream of `run`. A layer whose protocol has no
     * such request leaves it out.
     */
    stopItem?(id: string): Promise<boolean>;
    /** Tells the agent to stop the turn. Settles once it is written, so the session may close the agent's input after it. */
    cancel(): Promise<void>;
    /** Closes the connection, after the process is gone. */
    disconnect(): void;
}
