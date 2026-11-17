import { classifyFailure } from './failure';
import { runtimeToolName } from './tools';

import type {
    SDKAssistantMessage,
    SDKMessage,
    SDKPartialAssistantMessage,
    SDKRateLimitEvent,
    SDKResultMessage,
    SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { EngineEvent, SubagentState } from '../types';
import type { ClaudeAuth } from './config';

/** What a session has used so far, as the SDK reports it (cumulative). */
export interface Totals {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
}

export interface MapperOptions {
    auth: ClaudeAuth;
    /** Totals of sessions this daemon has measured before, by session id. The mapper reads and updates it. */
    totals: Map<string, Totals>;
    /** Whether this session continues an earlier one. A resumed session starts from the totals of its transcript. */
    resumed: boolean;
    /** Receives raw events worth keeping when debugging. */
    log?: (line: string) => void;
}

type SessionEvent = Extract<EngineEvent, { type: 'session' }>;
type TextEvent = Extract<EngineEvent, { type: 'text' }>;
type ToolEvent = Extract<EngineEvent, { type: 'tool' }>;
type SubagentEvent = Extract<EngineEvent, { type: 'subagent' }>;
type SystemMessage = Extract<SDKMessage, { type: 'system' }>;

interface Agent {
    name: string;
    parentToolCallId?: string;
    description?: string;
    state: SubagentState;
    summary?: string;
}

interface PendingTool {
    name: string;
    input: unknown;
    agentId?: string;
}

/** Task kinds that are agents. Shells, monitors and the like are not shown as child runs. */
const AGENT_TASKS = new Set(['local_agent', 'local_workflow']);

const TASK_STATES: Record<string, SubagentState> = {
    pending: 'running',
    running: 'running',
    paused: 'running',
    completed: 'done',
    failed: 'error',
    killed: 'cancelled',
    stopped: 'cancelled',
};

/** Tool output beyond this goes neither into the event log nor to the renderer. */
const MAX_OUTPUT_CHARS = 20_000;

function withAgent<T extends object>(event: T, agentId?: string): T & { agentId?: string } {
    return agentId === undefined ? event : { ...event, agentId };
}

function clip(text: string): string {
    return text.length > MAX_OUTPUT_CHARS ? `${ text.slice(0, MAX_OUTPUT_CHARS) }\n... (${ text.length - MAX_OUTPUT_CHARS } more characters)` : text;
}

/** The text of a `tool_result` or a message's content: text blocks joined, anything else named by its type. */
function textOf(content: unknown): string {
    if (typeof content === 'string') {
        return content;
    }

    if (!Array.isArray(content)) {
        return '';
    }

    return content.map((block: { type: string; text?: string }) => block.type === 'text' ? block.text ?? '' : `[${ block.type }]`).join('\n');
}

/**
 * Turns the SDK's messages into engine events. It holds what a message cannot say alone: which sub-agent a message
 * belongs to, which tool call a result answers, which text already went out as a stream, how much the session used.
 */
export class EventMapper {
    /** Set when the run is being cancelled; the turn's failure is then a cancellation, not an error. */
    interrupted = false;

    private sessionId?: string;
    private baseline?: Totals;
    private agents = new Map<string, Agent>();
    private agentOfToolCall = new Map<string, string>();
    private tools = new Map<string, PendingTool>();
    /** Per stream (the main agent or one sub-agent), the indexes of the text blocks being streamed. */
    private openText = new Map<string, Set<number>>();
    /** Messages whose text went out as stream deltas, so the complete message must not repeat it. */
    private streamed = new Set<string>();
    private apiError?: { kind: string; text: string };

    constructor(private options: MapperOptions) {}

    map(message: SDKMessage): EngineEvent[] {
        switch (message.type) {
            case 'system':
                return this.system(message);
            case 'stream_event':
                return this.stream(message);
            case 'assistant':
                return this.assistant(message);
            case 'user':
                return this.user(message);
            case 'result':
                return this.result(message);
            case 'rate_limit_event':
                return this.rateLimit(message);
            default:
                return [];
        }
    }

    private system(message: SystemMessage): EngineEvent[] {
        switch (message.subtype) {
            case 'init':
                return this.init(message.session_id);
            case 'task_started': {
                if (message.ambient || message.skip_transcript || (message.task_type && !AGENT_TASKS.has(message.task_type))) {
                    return [];
                }

                const agent: Agent = {
                    name: message.workflow_name ?? message.subagent_type ?? 'Sub-agent',
                    parentToolCallId: message.tool_use_id,
                    description: message.description,
                    state: 'running',
                };

                this.agents.set(message.task_id, agent);

                if (message.tool_use_id) {
                    this.agentOfToolCall.set(message.tool_use_id, message.task_id);
                }

                return [this.subagent(message.task_id, agent)];
            }
            case 'task_progress': {
                const agent = this.agents.get(message.task_id);

                if (!agent || !message.summary || message.summary === agent.summary) {
                    return [];
                }

                return [this.subagent(message.task_id, agent, agent.state, message.summary)];
            }
            case 'task_updated': {
                const agent = this.agents.get(message.task_id);
                const state = message.patch.status ? TASK_STATES[message.patch.status] : undefined;

                if (!agent || !state || state === agent.state) {
                    return [];
                }

                return [this.subagent(message.task_id, agent, state, message.patch.error)];
            }
            case 'task_notification': {
                const agent = this.agents.get(message.task_id);
                const state = TASK_STATES[message.status];

                // The notification repeats the end state `task_updated` reported, and adds the summary.
                if (!agent || (state === agent.state && !message.summary)) {
                    return [];
                }

                return [this.subagent(message.task_id, agent, state, message.summary)];
            }
            default:
                return [];
        }
    }

    private init(sessionId: string): EngineEvent[] {
        if (sessionId === this.sessionId) {
            return [];
        }

        this.sessionId = sessionId;
        this.baseline = this.options.totals.get(sessionId) ?? (this.options.resumed ? undefined : { inputTokens: 0, outputTokens: 0, costUsd: 0 });

        return [{ type: 'session', sessionId } satisfies SessionEvent];
    }

    /** Records the sub-agent's new state and returns the event for it. */
    private subagent(agentId: string, agent: Agent, state = agent.state, summary = agent.summary): SubagentEvent {
        agent.state = state;
        agent.summary = summary;

        return {
            type: 'subagent',
            agentId,
            name: agent.name,
            state,
            ...(agent.parentToolCallId && { parentToolCallId: agent.parentToolCallId }),
            ...(agent.description && { description: agent.description }),
            ...(summary && { summary }),
        };
    }

    /** The sub-agent a message came from. `undefined` is the main agent; `null` is a sub-agent that is not tracked. */
    private agentOf(message: { agent_id?: string; parent_tool_use_id: string | null }): string | undefined | null {
        const agentId = message.agent_id ?? (message.parent_tool_use_id ? this.agentOfToolCall.get(message.parent_tool_use_id) : undefined);

        return agentId === undefined && message.parent_tool_use_id ? null : agentId;
    }

    private stream(message: SDKPartialAssistantMessage): EngineEvent[] {
        const agentId = this.agentOf(message);

        if (agentId === null) {
            return [];
        }

        const key = message.parent_tool_use_id ?? '';
        const open = this.openText.get(key) ?? new Set<number>();
        const event = message.event;

        this.openText.set(key, open);

        switch (event.type) {
            case 'message_start':
                open.clear();
                this.streamed.add(event.message.id);

                return [];
            case 'content_block_start': {
                if (event.content_block.type !== 'text') {
                    return [];
                }

                open.add(event.index);

                return event.content_block.text ? [withAgent<TextEvent>({ type: 'text', delta: event.content_block.text, done: false }, agentId)] : [];
            }
            case 'content_block_delta':
                // Thinking and tool input deltas never reach the runtime.
                return event.delta.type === 'text_delta' && open.has(event.index)
                    ? [withAgent<TextEvent>({ type: 'text', delta: event.delta.text, done: false }, agentId)]
                    : [];
            case 'content_block_stop':
                if (!open.delete(event.index)) {
                    return [];
                }

                return [withAgent<TextEvent>({ type: 'text', delta: '', done: true }, agentId)];
            default:
                return [];
        }
    }

    private assistant(message: SDKAssistantMessage): EngineEvent[] {
        const agentId = this.agentOf(message);

        if (agentId === null) {
            return [];
        }

        const { content, id } = message.message;

        // The CLI reports an API failure as an assistant message; the turn's `result` follows and carries it as an error.
        if (message.error) {
            this.apiError = { kind: message.error, text: textOf(content) };

            return [];
        }

        const events: EngineEvent[] = [];

        for (const block of content) {
            if (block.type === 'text' && !this.streamed.has(id) && block.text.trim()) {
                events.push(withAgent<TextEvent>({ type: 'text', delta: block.text, done: true }, agentId));
            }
            else if (block.type === 'tool_use') {
                const name = runtimeToolName(block.name);

                this.tools.set(block.id, { name, input: block.input, agentId });
                events.push(withAgent<ToolEvent>({ type: 'tool', toolCallId: block.id, name, input: block.input, state: 'running' }, agentId));
            }
            // Thinking blocks are the model's own reasoning: never forwarded.
        }

        return events;
    }

    private user(message: SDKUserMessage): EngineEvent[] {
        const { content } = message.message;
        const events: EngineEvent[] = [];

        if (typeof content === 'string') {
            return events;
        }

        for (const block of content) {
            if (block.type !== 'tool_result') {
                continue;
            }

            const pending = this.tools.get(block.tool_use_id);

            if (!pending) {
                continue;
            }

            const text = clip(textOf(block.content));
            const outcome = block.is_error ? { state: 'error' as const, error: text } : { state: 'done' as const, output: text };

            this.tools.delete(block.tool_use_id);
            events.push(withAgent<ToolEvent>({ type: 'tool', toolCallId: block.tool_use_id, name: pending.name, input: pending.input, ...outcome }, pending.agentId));
        }

        return events;
    }

    private rateLimit(message: SDKRateLimitEvent): EngineEvent[] {
        const info = message.rate_limit_info;

        // The unit of `resetsAt` is not documented; keep the raw event until it is known.
        this.options.log?.(`rate_limit_event ${ JSON.stringify(info) }`);

        if (info.status === 'allowed') {
            return [];
        }

        return [{
            type: 'limit',
            status: info.status === 'rejected' ? 'rejected' : 'warning',
            ...(info.rateLimitType && { kind: info.rateLimitType }),
            ...(info.utilization !== undefined && { utilization: info.utilization }),
            ...(info.resetsAt !== undefined && { resetsAt: info.resetsAt }),
        }];
    }

    private result(message: SDKResultMessage): EngineEvent[] {
        const usage = this.usage(message);
        const failed = message.subtype !== 'success' || message.is_error;
        const { apiError } = this;

        this.apiError = undefined;

        if (this.interrupted && message.subtype === 'error_during_execution') {
            return this.endAgents();
        }

        // A queued message gets its own turn, and so does the report of a sub-agent still working in the background
        // (the CLI starts that turn by itself when the sub-agent ends): the session goes on.
        if (message.queued_turn_count || (!failed && this.working())) {
            return [usage];
        }

        if (!failed) {
            return [usage, { type: 'done', result: message.result }];
        }

        const failure = classifyFailure({
            auth: this.options.auth,
            kind: apiError?.kind,
            text: [apiError?.text, message.subtype === 'success' ? message.result : message.errors.join('\n')].filter(Boolean).join('\n'),
            terminalReason: message.terminal_reason,
            subtype: message.subtype,
        });

        return [...this.endAgents(), usage, { type: 'error', message: failure.message, retryable: failure.retryable, code: failure.code }];
    }

    /**
     * What this turn used. The SDK reports totals for the whole session, which a resumed session inherits from its
     * transcript; the runtime adds up what it is given, so the turn's share is the difference from the last totals.
     */
    private usage(message: SDKResultMessage): EngineEvent {
        const models = Object.values(message.modelUsage);
        const totals: Totals = {
            // The prompt as the model read it, cached parts included.
            inputTokens: models.reduce((sum, model) => sum + model.inputTokens + model.cacheCreationInputTokens + model.cacheReadInputTokens, 0),
            outputTokens: models.reduce((sum, model) => sum + model.outputTokens, 0),
            costUsd: message.total_cost_usd,
        };
        const before = this.baseline;

        this.baseline = totals;

        if (this.sessionId) {
            this.options.totals.set(this.sessionId, totals);
        }

        // A resumed session this daemon never measured has no known starting point: take the turn's own tokens, skip the cost.
        if (!before) {
            const { usage } = message;

            return { type: 'usage', inputTokens: usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens, outputTokens: usage.output_tokens };
        }

        return {
            type: 'usage',
            inputTokens: Math.max(0, totals.inputTokens - before.inputTokens),
            outputTokens: Math.max(0, totals.outputTokens - before.outputTokens),
            costUsd: Math.max(0, totals.costUsd - before.costUsd),
        };
    }

    private working(): boolean {
        return [...this.agents.values()].some(agent => agent.state === 'running');
    }

    /** Closes the sub-agents still running when the session ends; their process is about to go. */
    private endAgents(): EngineEvent[] {
        return [...this.agents].filter(([, agent]) => agent.state === 'running').map(([agentId, agent]) => this.subagent(agentId, agent, 'cancelled'));
    }
}
