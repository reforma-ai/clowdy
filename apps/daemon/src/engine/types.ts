import type { EngineId, ToolState } from '@clowdy/protocol';
import type { z } from 'zod';

/**
 * The seam between the run runtime and an agent engine (the Claude Agent SDK, Codex, or the scripted fake).
 *
 * The runtime owns everything durable: stream items, run status, task links, scheduling. An engine only turns a
 * prompt into a sequence of events and calls the tools it is given. It never writes to the database.
 */
export interface AgentEngine {
    id: EngineId;
    /** Starts a session that works on `prompt`. Nothing runs until the returned session is iterated. */
    start(options: EngineStartOptions): EngineSession;
}

export interface EngineStartOptions {
    /** Working directory of the agent. */
    cwd: string;
    /** The user's message or the executor's assignment. */
    prompt: string;
    systemPrompt?: string;
    /** A session id the engine reported earlier; continue that conversation. */
    resumeSessionId?: string;
    model?: string;
    /** Tools the runtime executes itself. The engine exposes them to the model and calls `execute`. */
    tools: ToolDefinition[];
    /** Aborted when the run is cancelled or the daemon stops. The session must end promptly. */
    signal: AbortSignal;
}

export interface EngineSession extends AsyncIterable<EngineEvent> {
    /** A follow-up user message while the session is live. */
    send(text: string): void;
    close(): void | Promise<void>;
}

/**
 * What a session reports. A turn ends with `done` or `error`; the runtime maps events to stream items.
 * An engine reports a tool by emitting `tool` events with the same `toolCallId`: the first one creates the item,
 * later ones update it in place.
 */
export type EngineEvent =
    | { type: 'session'; sessionId: string }
    /** A piece of the assistant's message. `done: true` ends the message; the next text starts a new one. */
    | { type: 'text'; delta: string; done: boolean; agentId?: string }
    | { type: 'tool'; toolCallId: string; name: string; input: unknown; state: ToolState; output?: unknown; error?: string; agentId?: string }
    /**
     * A sub-agent that lives inside the session (a Claude `Agent` or workflow task). The runtime shows it as a child run;
     * `text` and `tool` events with the same `agentId` belong to its stream.
     */
    | { type: 'subagent'; agentId: string; parentToolCallId?: string; name: string; description?: string; state: SubagentState; summary?: string }
    /** A subscription quota signal. `resetsAt` is passed through exactly as the engine reported it. */
    | { type: 'limit'; status: 'warning' | 'rejected'; kind?: string; utilization?: number; resetsAt?: number }
    /** The OS process behind the session, so the runtime can kill its group on cancel and after a daemon crash. */
    | { type: 'process'; pid: number; pgid?: number; startedAt?: number }
    | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd?: number }
    | { type: 'done'; result?: string }
    /** A failure that ends the turn. `code` is a stable identifier of the cause (`not_logged_in`, `usage_limit`, ...). */
    | { type: 'error'; message: string; retryable?: boolean; code?: string };

export type SubagentState = 'running' | 'done' | 'error' | 'cancelled';

/** A tool defined by the runtime: the model sees `name`, `description` and `inputSchema`; `execute` does the work. */
export interface ToolDefinition {
    name: string;
    description: string;
    /** JSON Schema of the input object. */
    inputSchema: Record<string, unknown>;
    /** The same schema as zod, for engines that register tools through zod (the Claude Agent SDK). */
    schema: z.ZodType;
    /** Validates `input` and runs the tool. Rejects with an Error whose message the model may read. */
    execute(input: unknown, signal: AbortSignal): Promise<unknown>;
}
