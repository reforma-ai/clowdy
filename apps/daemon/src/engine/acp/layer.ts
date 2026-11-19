import type { AgentProcess } from '../process';
import type { EngineEvent, EngineStartOptions } from '../types';
import type { BridgeAccess } from './bridge';
import type { AgentProtocol } from './catalog';
import type { ResolvedAgent } from './registry';
import type { SessionDeps } from './session';

/** Where a session's one prompt is: not sent yet, with the agent, or answered (or never to be sent: the session ended before it). */
export type PromptState = 'before' | 'running' | 'over';

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
    deps: Pick<SessionDeps, 'costs' | 'clientVersion' | 'initializeTimeoutMs' | 'log'>;
    /** Registers the runtime's tools with the bridge, once the agent has shaken hands, and gives back the MCP server to name in the session. `undefined` when the run has none. */
    openBridge(): BridgeAccess | undefined;
    /** Passes a title the agent gave to the runtime, which says whether it took it. */
    offerTitle(title: string): void;
    /** The option of a permission request the daemon answers with, or `undefined` to cancel the request. */
    pickPermission(options: readonly { optionId: string; kind: string }[]): string | undefined;
    /** Moves the prompt along and wakes the steers that wait for it. */
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
    /** Tells the agent to stop the turn. Settles once it is written, so the session may close the agent's input after it. */
    cancel(): Promise<void>;
    /** Closes the connection, after the process is gone. */
    disconnect(): void;
}
