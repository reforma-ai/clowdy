import type { BackgroundItem, EngineId, ToolState } from '@clowdy/protocol';
import type { z } from 'zod';

/**
 * The seam between the run runtime and an agent engine (an ACP agent, or the scripted fake).
 *
 * The runtime owns everything durable: stream items, run status, task links, scheduling. An engine only turns a
 * prompt into a sequence of events and calls the tools it is given. It never writes to the database.
 */
export interface AgentEngine {
    id: EngineId;
    /** Starts a session that works on `prompt`. Nothing runs until the returned session is iterated. */
    start(options: EngineStartOptions): EngineSession;
}

/**
 * The engines a daemon can run, by id. A `Map` is one; the ACP registry is another that finds agents when asked, so an
 * agent installed after the daemon started works without a restart.
 */
export interface EngineRegistry {
    get(id: EngineId): AgentEngine | undefined;
    has(id: EngineId): boolean;
}

export interface EngineStartOptions {
    /** Working directory of the agent. */
    cwd: string;
    /**
     * The project's other folders, as absolute paths, for the agent to read and change besides `cwd`. An engine hands them on only to an agent that
     * says it takes them; the system prompt names every folder for all agents.
     */
    additionalDirectories?: string[];
    /** The user's message, or the task a chat was started from. */
    prompt: string;
    systemPrompt?: string;
    /** A session id the engine reported earlier; continue that conversation. */
    resumeSessionId?: string;
    /**
     * What the conversation said so far, as text. An engine asks for it only when it was given `resumeSessionId` and could not continue that session
     * (the agent lost it, or cannot resume at all), and puts it before the prompt of the session it starts instead, so the agent is not left without
     * the story. It is a function because reading a long stream costs, and most turns resume fine.
     */
    history?: () => string | undefined;
    model?: string;
    /** The reasoning level, in the agent's own spelling; applied after `model`, since a model decides which levels exist. */
    effort?: string;
    /** What to do about the title the agent gives its session; absent leaves the agent to name it and the runtime to ignore the name. */
    title?: SessionTitle;
    /** Tools the runtime executes itself. The engine exposes them to the model and calls `execute`. */
    tools: ToolDefinition[];
    /** Aborted when the run is cancelled or the daemon stops. The session must end promptly. */
    signal: AbortSignal;
}

/**
 * An agent names its own session after the first message (Claude Code and Codex do, and tell a client by `session_info_update`), and does not
 * once the client has named it. Either way a session of the runtime's own chat has one of these; only a new session uses it, since one that
 * continues has its name already.
 */
export type SessionTitle =
    /**
     * Wants the agent's name. Called with each title the agent gives, which may come after the turn's last event: an engine whose agent has not
     * named the new session by then keeps it alive a few seconds for the name. Answers `true` for a title it took, which ends that wait, and `false`
     * for one it did not (an agent may first give the text of the message as a title).
     */
    | { onTitle: (title: string) => boolean }
    /** Names the session `keep` before the first message, so the agent keeps that title and spends no model call on one of its own. */
    | { keep: string };

export interface EngineSession extends AsyncIterable<EngineEvent> {
    /**
     * `false` when the session can take no steer at all (the agent did not say in its handshake that it can), so a steer will never be taken however early
     * it is asked; `true` or absent when it can, or when that is not known yet (an agent before its handshake). It says nothing of the turn: a steer that
     * is refused because the turn is over leaves it as it was. The runtime reads it to offer stop and send, which ends the turn so a message can start the next.
     */
    readonly canSteer?: boolean;
    /**
     * Hands a message from the person to the turn in flight, for the agent to take in without stopping (a steer). Resolves `true` when the agent took it,
     * so what it says from then on answers it too, and `false` when it did not (it cannot steer, or its turn is over): the runtime then keeps the message
     * for the next turn. An engine that cannot steer leaves it out.
     */
    steer?(text: string): Promise<boolean>;
    /**
     * Hands a prompt to the live session after its turn ended (`done`), for an agent that keeps the session open while it has background work to finish.
     * Resolves `true` when the session took it: the events of the turn it starts follow on this iterator and end with `done`, as any turn's do. Resolves
     * `false` when it did not (the session is over, or it cannot take a prompt now): the runtime then runs the message as the next turn of a session it
     * resumes. It is not a steer: a steer joins a turn that runs, this one starts a turn. When the agent is working on a turn of its own, the prompt joins
     * or follows it, and one `done` ends the whole activity that an accepted `send` leads to: the runtime counts one `done` per `send`, so an engine
     * holds back the `done` of the agent's own turn until the sent prompt has been answered. An engine that cannot take a prompt into a live session
     * leaves it out, and its session ends at `done`.
     */
    send?(text: string): Promise<boolean>;
    /**
     * Ends one thing the session has open and leaves the session and everything else it has open running: a sub-agent the session announced (the `agentId`
     * of its `subagent` event) or a background command (the `id` of its `background` item, which says `canStopAlone` when the agent lets the client end it).
     * Resolves `true` when the agent took the request, not when the thing ended: the end of a sub-agent arrives as the usual `subagent` event with state
     * `cancelled`, and the end of a command as a `background` snapshot without it, in the order the agent says things, so the runtime has one way for each to
     * end. Resolves `false` when nothing was asked or the agent did not take it: the session is over, the thing is unknown or has ended already, or the agent
     * did not offer to end it. Asked again for a sub-agent that is ending, it asks the agent again, which does nothing. A command the agent does not
     * list any more is gone, and answers `false`. An engine that cannot end one thing alone leaves it out.
     */
    stopItem?(id: string): Promise<boolean>;
    /**
     * `true` when the agent never starts a turn of its own to report background work that ended (Codex: nothing in its app-server wakes a thread when a
     * command or a sub-agent ends), so the runtime tells it: when the last item has left `background` and the session is idle, it hands the agent a note
     * through `send` (see `wakesOnBackgroundEnd` in the catalog). Absent or `false` for an agent that reports by itself (Claude Code), whose report turn is
     * waited for. Known once the session has resolved its agent.
     */
    readonly wakesOnBackgroundEnd?: boolean;
    close(): void | Promise<void>;
}

/**
 * What a session reports. A turn ends with `done` or `error`; the runtime maps events to stream items.
 * An engine reports a tool by emitting `tool` events with the same `toolCallId`: the first one creates the item,
 * later ones update it in place.
 *
 * A session may outlive its turn: an agent with background work open keeps the iterator going after `done`, and what it does next (more `background`
 * snapshots, a turn it starts on its own, one `send` asked for) follows on the same iterator, each turn ending with `done`. The iterator ends when
 * the agent has nothing open any more, or the session is closed.
 */
export type EngineEvent =
    | { type: 'session'; sessionId: string }
    /** A piece of the assistant's message. `done: true` ends the message; the next text starts a new one. */
    | { type: 'text'; delta: string; done: boolean; agentId?: string }
    | { type: 'tool'; toolCallId: string; name: string; input: unknown; state: ToolState; output?: unknown; error?: string; agentId?: string }
    /**
     * A sub-agent that lives inside the session (an agent's own `Agent` or `Task`, when the engine can tell). The runtime shows it as a child run;
     * `text` and `tool` events with the same `agentId` belong to its stream. `stoppable`, on the event that makes the child run (its first), says the
     * agent lets the client end this sub-agent alone with `EngineSession.stopItem`; the run is told, so the app offers a Stop for it. Absent means it
     * does not. `parentAgentId` names the sub-agent that started this one (a sub-agent of a sub-agent: its run is made below that one's, and is kept
     * while that one is); absent when the session's own agent did.
     */
    | { type: 'subagent'; agentId: string; parentAgentId?: string; parentToolCallId?: string; name: string; description?: string; state: SubagentState; summary?: string; stoppable?: boolean }
    /** A subscription quota signal. `resetsAt` is passed through exactly as the engine reported it. */
    | { type: 'limit'; status: 'warning' | 'rejected'; kind?: string; utilization?: number; resetsAt?: number }
    /** The OS process behind the session, so the runtime can kill its group on cancel and after a daemon crash. */
    | { type: 'process'; pid: number; pgid?: number; startedAt?: number }
    /** How full the session's context window is: tokens in it and the window's size. Only agents that report it send one. */
    | { type: 'context'; used: number; size: number }
    | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd?: number }
    /**
     * What the agent has open in the background (a command, a sub-agent, a workflow): the complete list, not a change, sent again whenever it changes, so
     * an item that is missing from the next one has finished and an empty list means nothing is open. An agent that cannot tell never sends one. The
     * runtime reads the latest list when a turn's `done` arrives, to decide whether the session stays open, so a turn's list comes before its `done`. An
     * item's `id` is the one a sub-agent has as its `agentId` or as the `parentToolCallId` of its `subagent` event: that is how the runtime knows which
     * sub-agent the item is. `calls` are the ids of tool calls that are still running and are the work some of these items stand for: Codex keeps the call of
     * a command that outlived its turn running for as long as the command does, so the turn's end must not fail it. Absent when there are none.
     */
    | { type: 'background'; items: BackgroundItem[]; calls?: string[] }
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
    /** The same schema as zod, for validating the input. */
    schema: z.ZodType;
    /**
     * Set on a tool that is also a shell command for the agent (`thread_tell` is `clowdy thread tell`): its input is flat, so each field is a flag.
     * `positional` names the fields that may come as plain arguments instead, in their order (`clowdy thread tell <thread> <message>`). Absent on a tool
     * that is only a tool.
     */
    cli?: { positional?: readonly string[] };
    /** Validates `input` and runs the tool. Rejects with an Error whose message the model may read. */
    execute(input: unknown, signal: AbortSignal): Promise<unknown>;
}
