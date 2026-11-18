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
    /** What was last sent, to skip updates that change nothing. */
    sent?: string;
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
 * message, the tool calls, and the numbers (cumulative cost, rate limits) the updates carry.
 */
export class UpdateMapper {
    private message = '';
    private open = false;
    private openId?: string;
    private last = '';
    private tools = new Map<string, Tool>();
    /** The session's cumulative cost in USD, as of the latest `usage_update`. */
    cost?: number;
    private limit?: string;
    private fill?: string;

    constructor(private options: MapperOptions) {}

    /** The text of the last assistant message so far: what `done` reports. */
    result(): string | undefined {
        return (this.open ? this.message : this.last).trim() || undefined;
    }

    update(update: SessionUpdate): EngineEvent[] {
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

    /** Ends the open assistant message, if there is one. */
    close(): EngineEvent[] {
        if (!this.open) {
            return [];
        }

        this.open = false;
        this.openId = undefined;
        this.last = this.message;
        this.message = '';

        return [{ type: 'text', delta: '', done: true }];
    }

    private text(delta: string, messageId: string | undefined): EngineEvent[] {
        const events: EngineEvent[] = [];

        // A new message id is a new message, even with nothing between.
        if (this.open && messageId !== undefined && this.openId !== undefined && messageId !== this.openId) {
            events.push(...this.close());
        }

        if (!delta) {
            return events;
        }

        this.open = true;
        this.openId ??= messageId;
        this.message += delta;
        events.push({ type: 'text', delta, done: false });

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

    private tool(update: ToolCall | ToolCallUpdate): EngineEvent[] {
        const id = update.toolCallId;
        const known = this.tools.get(id);
        const tool: Tool = known ?? { name: '', input: undefined, state: 'running' };

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
        };
        const signature = JSON.stringify(event);

        if (signature === tool.sent) {
            return [];
        }

        tool.sent = signature;

        return [event];
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
