import { STOPPED_TOOL } from '@clowdy/protocol';

import type { EngineEvent } from '../types';

/*
 * What the update mappers of both protocols build their events from: tool names and states, tool results, the assistant message as it streams, and
 * the numbers an agent reports (context window, cost, rate limits). The mappers read their own protocol's update shapes (`mapper.ts` for ACP v1,
 * `mapper-v2.ts` for v2) and hand these classes what they found.
 */

/** A tool result longer than this is cut: the stream is for reading, and the agent's transcript keeps the rest. */
const MAX_OUTPUT_CHARS = 20_000;

export type ToolEvent = Extract<EngineEvent, { type: 'tool' }>;
export type Json = { [key: string]: unknown };

export const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function clip(text: string): string {
    return text.length > MAX_OUTPUT_CHARS ? `${ text.slice(0, MAX_OUTPUT_CHARS) }\n[cut: ${ text.length - MAX_OUTPUT_CHARS } more characters]` : text;
}

/** What a tool kind is called when the agent gives the call no name of its own. These are the names the stream view recognizes. */
const KIND_NAMES: Record<string, string> = {
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

/** The name every agent's compaction call gets, so the stream draws it as one line whatever agent ran it: Claude's adapter already calls it this. */
export const COMPACT_TOOL = 'compact';

/** The title Claude's and Codex's adapters both give the call that compacts the conversation (a `think` call; Codex names it no other way). */
const COMPACT_TITLE = 'Compact conversation';

/** The text a tool result holds, from the raw output the agent attached or the text of the content it showed (`shown`). */
function outputOf(rawOutput: unknown, shown: string | undefined): string | undefined {
    if (typeof rawOutput === 'string' && rawOutput) {
        return rawOutput;
    }

    if (shown) {
        return shown;
    }

    if (isRecord(rawOutput)) {
        const named = ['output', 'stdout', 'text', 'content', 'result'].map(key => rawOutput[key]).find((value): value is string => typeof value === 'string' && value !== '');

        return named ?? JSON.stringify(rawOutput);
    }

    return rawOutput === undefined || rawOutput === null ? undefined : String(rawOutput);
}

/** What a tool call update says, in the terms of either protocol: the mappers read their update into this. */
export interface ToolFacts {
    toolCallId: string;
    name?: string | null;
    title?: string | null;
    kind?: string | null;
    status?: string | null;
    rawInput?: unknown;
    rawOutput?: unknown;
    /** The text of the content the call showed (a diff as the file it changed). */
    shown?: string;
    _meta?: Json | null;
}

export interface Tool {
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

/** The tool calls of one prompt, by id. */
export class ToolLedger {
    private tools = new Map<string, Tool>();

    /** `toolNames`: the tools the runtime handed this agent, to recognize calls to them under whatever name the agent shows. */
    constructor(private toolNames: readonly string[]) {}

    get(id: string): Tool | undefined {
        return this.tools.get(id);
    }

    has(id: string): boolean {
        return this.tools.has(id);
    }

    set(id: string, tool: Tool): void {
        this.tools.set(id, tool);
    }

    /** The name the runtime knows a tool call by: its own tool's bare name, else the agent's name for it, else its kind. */
    private nameOf(update: ToolFacts, previous?: string): string {
        const claude = (update._meta?.claudeCode as { toolName?: unknown } | undefined)?.toolName;
        const candidates = [typeof claude === 'string' ? claude : undefined, update.name ?? undefined, update.title ?? undefined].filter((value): value is string => Boolean(value));

        // The runtime's own tools reach the agent as an MCP server called `clowdy`; agents show them as `mcp__clowdy__task_list`,
        // `clowdy/task_list`, `Tool: clowdy.task_list` and so on.
        for (const tool of this.toolNames) {
            // `mcp__clowdy__task_list` has the name behind a double underscore; `my_task_list` is another tool.
            const pattern = new RegExp(`(?:^|[^a-z0-9_]|__)${ escape(tool) }(?:$|[^a-z0-9_])`, 'i');

            if (candidates.some(text => text === tool || (/clowdy/i.test(text) && pattern.test(text)))) {
                return tool;
            }
        }

        // A compaction is a `think` call by its title (Codex) or by Claude's tool name; a later update that names nothing of its own keeps the name.
        if (claude === COMPACT_TOOL || (update.title === COMPACT_TITLE && (!update.kind || update.kind === 'think')) || (previous === COMPACT_TOOL && !claude && !update.name)) {
            return COMPACT_TOOL;
        }

        const kind = update.kind ? KIND_NAMES[update.kind] ?? '' : '';

        return (typeof claude === 'string' && claude) || update.name || kind || previous || update.title || 'Tool';
    }

    /**
     * Takes one update of a tool call of the session, or of the sub-agent `agentId`. Gives back the event that says how the call stands now, or
     * nothing when the update changes nothing of what was last said.
     */
    apply(update: ToolFacts, agentId?: string): ToolEvent | undefined {
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
            const text = outputOf(update.rawOutput, update.shown);

            tool.state = update.status === 'failed' ? 'error' : 'done';

            if (update.status === 'failed') {
                tool.error = clip(text ?? 'The tool failed');
            }
            else if (text !== undefined) {
                tool.output = clip(text);
            }
        }
        else if (update.status === 'cancelled') {
            // A call the agent cancelled was stopped, not failed: the app reads this text as such.
            tool.state = 'error';
            tool.error = STOPPED_TOOL;
        }
        else if (update.status === 'pending' || update.status === 'in_progress' || update.status === 'paused') {
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
            return undefined;
        }

        tool.sent = signature;

        return event;
    }
}

/**
 * An assistant message as it streams. The session's own and each sub-agent's are kept apart (one `Message` each), so one never closes or joins
 * another.
 */
export class Message {
    private text = '';
    private open = false;
    private openId?: string;
    private last = '';
    /** The ids of the messages that were closed, so a whole message that comes again is not shown twice. */
    private closed = new Set<string>();

    /** The text of the last message so far: what `done` reports. */
    result(): string | undefined {
        return (this.open ? this.text : this.last).trim() || undefined;
    }

    /** Adds `delta` to the message called `messageId` (an agent may name none). A new id is a new message, even with nothing between. */
    append(delta: string, messageId: string | undefined, agentId?: string): EngineEvent[] {
        const events: EngineEvent[] = [];

        if (this.open && messageId !== undefined && this.openId !== undefined && messageId !== this.openId) {
            events.push(...this.close(agentId));
        }

        if (!delta) {
            return events;
        }

        this.open = true;
        this.openId ??= messageId;
        this.text += delta;
        events.push({ type: 'text', delta, done: false, ...(agentId !== undefined && { agentId }) });

        return events;
    }

    /**
     * A message the agent sends whole, as it has it now (ACP v2 upserts them): the stream only grows, so what shows is what the open message
     * lacks. One that was shown and closed already, or that does not continue the open message, adds nothing.
     */
    upsert(messageId: string, text: string, agentId?: string): EngineEvent[] {
        if (this.open && this.openId === messageId) {
            return text.startsWith(this.text) ? this.append(text.slice(this.text.length), messageId, agentId) : [];
        }

        return this.closed.has(messageId) ? [] : this.append(text, messageId, agentId);
    }

    /** Whether a message called `messageId` could repeat the last closed one: nothing is open, the id is new, and there is a last message to repeat. */
    mayRepeat(messageId: string): boolean {
        return !this.open && !this.closed.has(messageId) && this.last.trim() !== '';
    }

    /** Whether `text`, a message so far, is still the start of what the last closed message said, or all of it. */
    startsLast(text: string): boolean {
        return this.last.trim().startsWith(text.trim());
    }

    /**
     * Whether `text` is a whole message that says again what the last closed message said, under another id (the turn that follows a steer repeats
     * the answer the steer was folded into). It is remembered as shown, so it adds nothing now and nothing when the agent sends it again.
     */
    repeats(messageId: string, text: string): boolean {
        if (this.open || this.closed.has(messageId) || !this.last.trim() || text.trim() !== this.last.trim()) {
            return false;
        }

        this.closed.add(messageId);

        return true;
    }

    /** Forgets the last closed message: a turn that says nothing has no result of its own. */
    forget(): void {
        this.last = '';
    }

    /** Ends the open message, if there is one. */
    close(agentId?: string): EngineEvent[] {
        if (!this.open) {
            return [];
        }

        this.open = false;

        if (this.openId !== undefined) {
            this.closed.add(this.openId);
        }

        this.openId = undefined;
        this.last = this.text;
        this.text = '';

        return [{ type: 'text', delta: '', done: true, ...(agentId !== undefined && { agentId }) }];
    }
}

/** The tokens a prompt used, as an agent reports them. */
export interface Tokens {
    inputTokens?: number | null;
    outputTokens?: number | null;
    cachedReadTokens?: number | null;
    cachedWriteTokens?: number | null;
}

/** What a prompt used: its tokens, and the rise of the session's cumulative cost over `costBefore` (unknown for a session this daemon never measured). */
export function usageEvent(tokens: Tokens | null | undefined, cost: number | undefined, costBefore: number | undefined): EngineEvent[] {
    const costUsd = cost !== undefined && costBefore !== undefined ? Math.max(0, cost - costBefore) : undefined;

    if (!tokens && costUsd === undefined) {
        return [];
    }

    return [{
        type: 'usage',
        // The prompt as the model read it, cached parts included.
        inputTokens: (tokens?.inputTokens ?? 0) + (tokens?.cachedReadTokens ?? 0) + (tokens?.cachedWriteTokens ?? 0),
        outputTokens: tokens?.outputTokens ?? 0,
        ...(costUsd !== undefined && { costUsd }),
    }];
}

/** A `usage_update`: the window's fill, the session's cost so far, and whatever rides in its `_meta`. */
export interface UsageFacts {
    used: number;
    size: number;
    cost?: { amount: number; currency: string } | null;
    _meta?: Json | null;
}

/** The numbers an agent reports along the way: the session's cumulative cost, the window's fill, and rate limit signals. */
export class Gauges {
    /** The session's cumulative cost in USD, as of the latest `usage_update`. */
    cost?: number;
    private limit?: string;
    private fill?: string;

    constructor(private log?: (line: string) => void) {}

    update(update: UsageFacts): EngineEvent[] {
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

    private rateLimit(update: UsageFacts): EngineEvent[] {
        // Claude's adapter forwards the SDK's rate-limit info; no other agent says anything about quotas.
        const info = update._meta?.['_claude/rateLimit'];

        if (!isRecord(info)) {
            return [];
        }

        this.log?.(`rate limit ${ JSON.stringify(info) }`);

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
