import type { PromptResponse, SessionUpdate, ToolCall, ToolCallContent, ToolCallUpdate, ToolKind } from '@agentclientprotocol/sdk/unstable';
import type { EngineEvent } from '../types';

/** A tool result longer than this is cut: the stream is for reading, and the agent's transcript keeps the rest. */
const MAX_OUTPUT_CHARS = 20_000;

type ToolEvent = Extract<EngineEvent, { type: 'tool' }>;
type Json = { [key: string]: unknown };

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function clip(text: string): string {
    return text.length > MAX_OUTPUT_CHARS ? `${ text.slice(0, MAX_OUTPUT_CHARS) }\n[cut: ${ text.length - MAX_OUTPUT_CHARS } more characters]` : text;
}

/** What a tool kind is called when the agent gives the call no name of its own. These are the names the stream view recognizes. */
const KIND_NAMES: { [kind in ToolKind]: string } = {
    read: 'Read',
    edit: 'Edit',
    delete: 'Delete',
    move: 'Move',
    search: 'Grep',
    execute: 'Bash',
    think: 'Think',
    fetch: 'WebFetch',
    switch_mode: 'SwitchMode',
    other: '',
};

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text a tool result holds, from the raw output the agent attached or the content blocks it showed. */
function outputOf(rawOutput: unknown, content: ToolCallContent[] | null | undefined): string | undefined {
    if (typeof rawOutput === 'string' && rawOutput) {
        return rawOutput;
    }

    const fromContent = (content ?? []).map((item) => {
        if (item.type === 'content') {
            return item.content.type === 'text' ? item.content.text : '';
        }

        return item.type === 'diff' ? `Changed ${ item.path }` : '';
    }).filter(Boolean).join('\n');

    if (fromContent) {
        return fromContent;
    }

    if (isRecord(rawOutput)) {
        const named = ['output', 'stdout', 'text', 'content', 'result'].map(key => rawOutput[key]).find((value): value is string => typeof value === 'string' && value !== '');

        return named ?? JSON.stringify(rawOutput);
    }

    return rawOutput === undefined || rawOutput === null ? undefined : String(rawOutput);
}

interface Tool {
    name: string;
    input: unknown;
    state: ToolEvent['state'];
    output?: string;
    error?: string;
    /** The sub-agent that made the call, when it was not the session's own. */
    agentId?: string;
    /** What was last sent, to skip updates that change nothing. */
    sent?: string;
}

/** An assistant message as it streams. The session's own and each sub-agent's are kept apart, so one never closes or joins another. */
interface Message {
    text: string;
    open: boolean;
    openId?: string;
}

/** A sub-agent the agent reported inside this prompt, known by the id of the call that started it. */
interface Child {
    name: string;
    message: Message;
    /** The call that started it ended, and so did it: whatever it still reports is dropped. */
    ended: boolean;
}

/** A sub-agent's brief longer than this is cut: it is a one-line summary of the run, and the whole prompt is in the parent's call. */
const MAX_BRIEF_CHARS = 120;

/**
 * The call whose sub-agent sent an update. Claude's adapter, when the client has not opted in to child sessions, reports a sub-agent's
 * messages and tool calls on the parent's session and stamps each with the id of the `Agent` or `Task` call that started it.
 */
function parentToolUseOf(update: SessionUpdate): string | undefined {
    const claude = (update as { _meta?: Json | null })._meta?.claudeCode;
    const id = isRecord(claude) ? claude.parentToolUseId : undefined;

    return typeof id === 'string' && id !== '' ? id : undefined;
}

/** A sub-agent's name and brief, from the input of the call that started it: Claude's `Agent` and `Task` take `subagent_type`, `description` and `prompt`. */
function identityOf(input: unknown): { name: string; description?: string } {
    const field = (key: string) => {
        const value = isRecord(input) ? input[key] : undefined;

        return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
    };
    const brief = field('prompt')?.split('\n')[0].trim();

    return {
        name: field('name') ?? field('subagent_type') ?? 'Sub-agent',
        description: field('description') ?? (brief && brief.length > MAX_BRIEF_CHARS ? `${ brief.slice(0, MAX_BRIEF_CHARS) }…` : brief),
    };
}

/** How the engine's numbers move: cumulative cost the agent reported, and the baseline this prompt started from. */
export interface MapperOptions {
    /** The tool names the runtime handed this agent, to recognize calls to them under whatever name the agent shows. */
    toolNames: readonly string[];
    /** The session's cost in USD before this prompt, or `undefined` when unknown (a resumed session this daemon never measured). */
    costBefore?: number;
    log?: (line: string) => void;
}

/**
 * Turns the `session/update`s of one prompt into engine events. One mapper per prompt: it tracks the open assistant
 * message, the tool calls, the sub-agents, and the numbers (cumulative cost, rate limits) the updates carry.
 *
 * A sub-agent's updates carry its `agentId` (the id of the call that started it), so the runtime writes them to a child run instead of the
 * parent's stream. Its first update announces it with a `subagent` event, and the end of the call that started it ends it, with that call's
 * result as its report. An agent that does not say which updates are a sub-agent's leaves them in the parent's stream, and its call stays a
 * plain tool call.
 */
export class UpdateMapper {
    /** The session's own message. */
    private message: Message = { text: '', open: false };
    private last = '';
    private tools = new Map<string, Tool>();
    private children = new Map<string, Child>();
    /** The session's cumulative cost in USD, as of the latest `usage_update`. */
    cost?: number;
    private limit?: string;
    private fill?: string;

    constructor(private options: MapperOptions) {}

    /** The text of the session's last assistant message so far: what `done` reports. */
    result(): string | undefined {
        return (this.message.open ? this.message.text : this.last).trim() || undefined;
    }

    update(update: SessionUpdate): EngineEvent[] {
        const agentId = this.ownerOf(update);

        if (agentId !== undefined) {
            return this.child(agentId, update);
        }

        switch (update.sessionUpdate) {
            case 'agent_message_chunk':
                return update.content.type === 'text' ? this.text(update.content.text, update.messageId ?? undefined) : [];
            case 'tool_call':
                return [...this.close(), ...this.tool(update)];
            case 'tool_call_update':
                return this.tool(update);
            case 'usage_update':
                return this.usage(update);
            default:
                // Thoughts, plans, commands, modes, titles: nothing the runtime shows today.
                return [];
        }
    }

    /** The prompt ended: closes the open message and reports what the prompt used. */
    stop(response: PromptResponse): EngineEvent[] {
        const events = this.close();
        const { usage } = response;
        const costUsd = this.cost !== undefined && this.options.costBefore !== undefined ? Math.max(0, this.cost - this.options.costBefore) : undefined;

        if (usage || costUsd !== undefined) {
            events.push({
                type: 'usage',
                // The prompt as the model read it, cached parts included.
                inputTokens: (usage?.inputTokens ?? 0) + (usage?.cachedReadTokens ?? 0) + (usage?.cachedWriteTokens ?? 0),
                outputTokens: usage?.outputTokens ?? 0,
                ...(costUsd !== undefined && { costUsd }),
            });
        }

        return events;
    }

    /** Ends the open assistant message of the session, or of the sub-agent `agentId`, if there is one. */
    close(agentId?: string): EngineEvent[] {
        const message = this.messageOf(agentId);

        if (!message.open) {
            return [];
        }

        message.open = false;
        message.openId = undefined;

        if (agentId === undefined) {
            this.last = message.text;
        }

        message.text = '';

        return [{ type: 'text', delta: '', done: true, ...(agentId !== undefined && { agentId }) }];
    }

    /**
     * The sub-agent an update belongs to: the call Claude's adapter stamped on it, else the sub-agent that made the tool call it updates, since a
     * later update of a call can come without the stamp (a progress beat after the sub-agent finished).
     */
    private ownerOf(update: SessionUpdate): string | undefined {
        const isTool = update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update';
        const stamped = parentToolUseOf(update);

        // A call is never its own sub-agent's.
        if (stamped !== undefined && !(isTool && stamped === update.toolCallId)) {
            return stamped;
        }

        return isTool ? this.tools.get(update.toolCallId)?.agentId : undefined;
    }

    /** An update of a sub-agent: its first one announces it, then its messages and tool calls go to its own stream. */
    private child(agentId: string, update: SessionUpdate): EngineEvent[] {
        const events: EngineEvent[] = [];
        let child = this.children.get(agentId);

        if (!child) {
            const call = this.tools.get(agentId);

            // A sub-agent first heard of after the call that started it ended has nothing left to show.
            if (call && call.state !== 'running') {
                return this.drop(agentId, update);
            }

            const { name, description } = identityOf(call?.input);

            child = { name, message: { text: '', open: false }, ended: false };
            this.children.set(agentId, child);
            events.push({ type: 'subagent', agentId, parentToolCallId: agentId, name, ...(description !== undefined && { description }), state: 'running' });
        }

        if (child.ended) {
            return this.drop(agentId, update);
        }

        switch (update.sessionUpdate) {
            case 'agent_message_chunk':
                if (update.content.type === 'text') {
                    events.push(...this.text(update.content.text, update.messageId ?? undefined, agentId));
                }

                break;
            case 'tool_call':
                events.push(...this.close(agentId), ...this.tool(update, agentId));
                break;
            case 'tool_call_update':
                events.push(...this.tool(update, agentId));
                break;
            default:
                // Its thoughts and plans are not shown, as the session's own are not; the window and the cost are the session's.
                break;
        }

        return events;
    }

    /**
     * Drops an update of a sub-agent whose call already ended. A call it makes then stays known as its, so a later update of that call without
     * the stamp is dropped too instead of landing in the session's stream.
     */
    private drop(agentId: string, update: SessionUpdate): EngineEvent[] {
        if ((update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') && !this.tools.has(update.toolCallId)) {
            this.tools.set(update.toolCallId, { name: '', input: undefined, state: 'running', agentId });
        }

        return [];
    }

    private messageOf(agentId: string | undefined): Message {
        return (agentId === undefined ? undefined : this.children.get(agentId)?.message) ?? this.message;
    }

    private text(delta: string, messageId: string | undefined, agentId?: string): EngineEvent[] {
        const message = this.messageOf(agentId);
        const events: EngineEvent[] = [];

        // A new message id is a new message, even with nothing between.
        if (message.open && messageId !== undefined && message.openId !== undefined && messageId !== message.openId) {
            events.push(...this.close(agentId));
        }

        if (!delta) {
            return events;
        }

        message.open = true;
        message.openId ??= messageId;
        message.text += delta;
        events.push({ type: 'text', delta, done: false, ...(agentId !== undefined && { agentId }) });

        return events;
    }

    /** The name the runtime knows a tool call by: its own tool's bare name, else the agent's name for it, else its kind. */
    private nameOf(update: ToolCall | ToolCallUpdate, previous?: string): string {
        const claude = (update._meta?.claudeCode as { toolName?: unknown } | undefined)?.toolName;
        const candidates = [typeof claude === 'string' ? claude : undefined, update.name ?? undefined, update.title ?? undefined].filter((value): value is string => Boolean(value));

        // The runtime's own tools reach the agent as an MCP server called `clowdy`; agents show them as `mcp__clowdy__task_list`,
        // `clowdy/task_list`, `Tool: clowdy.task_list` and so on.
        for (const tool of this.options.toolNames) {
            // `mcp__clowdy__task_list` has the name behind a double underscore; `my_task_list` is another tool.
            const pattern = new RegExp(`(?:^|[^a-z0-9_]|__)${ escape(tool) }(?:$|[^a-z0-9_])`, 'i');

            if (candidates.some(text => text === tool || (/clowdy/i.test(text) && pattern.test(text)))) {
                return tool;
            }
        }

        const kind = update.kind ? KIND_NAMES[update.kind] : '';

        return (typeof claude === 'string' && claude) || update.name || kind || previous || update.title || 'Tool';
    }

    /** A tool call of the session, or of the sub-agent `agentId`. */
    private tool(update: ToolCall | ToolCallUpdate, agentId?: string): EngineEvent[] {
        const id = update.toolCallId;
        const known = this.tools.get(id);
        const tool: Tool = known ?? { name: '', input: undefined, state: 'running', ...(agentId !== undefined && { agentId }) };

        tool.name = this.nameOf(update, known?.name);

        if (update.rawInput !== undefined && update.rawInput !== null) {
            tool.input = update.rawInput;
        }
        else if (tool.input === undefined && update.title) {
            tool.input = { title: update.title };
        }

        if (update.status === 'completed' || update.status === 'failed') {
            const text = outputOf(update.rawOutput, update.content);

            tool.state = update.status === 'failed' ? 'error' : 'done';

            if (update.status === 'failed') {
                tool.error = clip(text ?? 'The tool failed');
            }
            else if (text !== undefined) {
                tool.output = clip(text);
            }
        }
        else if (update.status === 'pending' || update.status === 'in_progress') {
            tool.state = 'running';
        }

        this.tools.set(id, tool);

        const event: ToolEvent = {
            type: 'tool',
            toolCallId: id,
            name: tool.name,
            input: tool.input ?? {},
            state: tool.state,
            ...(tool.output !== undefined && { output: tool.output }),
            ...(tool.error !== undefined && { error: tool.error }),
            ...(tool.agentId !== undefined && { agentId: tool.agentId }),
        };
        const signature = JSON.stringify(event);

        if (signature === tool.sent) {
            return [];
        }

        tool.sent = signature;

        return [event, ...this.settle(id, tool)];
    }

    /** The call that started a sub-agent ended, and so did the sub-agent: the call's result is its report. */
    private settle(id: string, call: Tool): EngineEvent[] {
        const child = this.children.get(id);

        if (!child || child.ended || call.state === 'running') {
            return [];
        }

        const summary = call.state === 'error' ? call.error : call.output;
        const events = this.close(id);

        child.ended = true;
        events.push({ type: 'subagent', agentId: id, parentToolCallId: id, name: child.name, state: call.state, ...(summary !== undefined && { summary }) });

        return events;
    }

    private usage(update: Extract<SessionUpdate, { sessionUpdate: 'usage_update' }>): EngineEvent[] {
        if (update.cost && update.cost.currency === 'USD' && Number.isFinite(update.cost.amount)) {
            this.cost = update.cost.amount;
        }

        return [...this.context(update), ...this.rateLimit(update)];
    }

    /** The window's fill, when the agent reports one that makes sense. The agents repeat it with every update. */
    private context({ used, size }: { used: number; size: number }): EngineEvent[] {
        if (!Number.isFinite(used) || !Number.isFinite(size) || used < 0 || size <= 0) {
            return [];
        }

        const signature = `${ used }/${ size }`;

        if (signature === this.fill) {
            return [];
        }

        this.fill = signature;

        return [{ type: 'context', used, size }];
    }

    private rateLimit(update: Extract<SessionUpdate, { sessionUpdate: 'usage_update' }>): EngineEvent[] {
        // Claude's adapter forwards the SDK's rate-limit info; no other agent says anything about quotas.
        const info = update._meta?.['_claude/rateLimit'];

        if (!isRecord(info)) {
            return [];
        }

        this.options.log?.(`rate limit ${ JSON.stringify(info) }`);

        if (info.status !== 'allowed_warning' && info.status !== 'rejected') {
            return [];
        }

        const event: EngineEvent = {
            type: 'limit',
            status: info.status === 'rejected' ? 'rejected' : 'warning',
            ...(typeof info.rateLimitType === 'string' && { kind: info.rateLimitType }),
            ...(typeof info.utilization === 'number' && { utilization: info.utilization }),
            ...(typeof info.resetsAt === 'number' && { resetsAt: info.resetsAt }),
        };
        const signature = JSON.stringify(event);

        // The adapter repeats the same info with every update.
        if (signature === this.limit) {
            return [];
        }

        this.limit = signature;

        return [event];
    }
}
