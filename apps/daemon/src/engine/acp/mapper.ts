import { Gauges, isRecord, Message, Thought, ToolLedger, usageEvent } from './mapper-core';

import type { PromptResponse, SessionUpdate, ToolCall, ToolCallContent, ToolCallUpdate } from '@agentclientprotocol/sdk/unstable';
import type { EngineEvent } from '../types';
import type { Json } from './mapper-core';

/** The text of the content a tool call showed: the text blocks, and a diff as the file it changed. */
function shownOf(content: ToolCallContent[] | null | undefined): string | undefined {
    return (content ?? []).map((item) => {
        if (item.type === 'content') {
            return item.content.type === 'text' ? item.content.text : '';
        }

        return item.type === 'diff' ? `Changed ${ item.path }` : '';
    }).filter(Boolean).join('\n') || undefined;
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
    private message = new Message();
    /** The session's own reasoning. A sub-agent's is not shown. */
    private thought = new Thought();
    private tools: ToolLedger;
    private children = new Map<string, Child>();
    private gauges: Gauges;

    constructor(private options: MapperOptions) {
        this.tools = new ToolLedger(options.toolNames);
        this.gauges = new Gauges(options.log);
    }

    /** The session's cumulative cost in USD, as of the latest `usage_update`. */
    get cost(): number | undefined {
        return this.gauges.cost;
    }

    /** The text of the session's last assistant message so far: what `done` reports. */
    result(): string | undefined {
        return this.message.result();
    }

    update(update: SessionUpdate): EngineEvent[] {
        const agentId = this.ownerOf(update);

        if (agentId !== undefined) {
            return this.child(agentId, update);
        }

        switch (update.sessionUpdate) {
            case 'agent_message_chunk':
                return update.content.type === 'text' ? [...this.thought.close(), ...this.message.append(update.content.text, update.messageId ?? undefined)] : [];
            case 'agent_thought_chunk':
                return update.content.type === 'text' ? this.thought.append(update.content.text, update.messageId ?? undefined) : [];
            case 'tool_call':
                return [...this.close(), ...this.tool(update)];
            case 'tool_call_update':
                return this.tool(update);
            case 'usage_update':
                return this.gauges.update(update);
            default:
                // Plans, commands, modes, titles: nothing the runtime shows today.
                return [];
        }
    }

    /** The prompt ended: closes the open message and reports what the prompt used. */
    stop(response: PromptResponse): EngineEvent[] {
        return [...this.close(), ...usageEvent(response.usage, this.gauges.cost, this.options.costBefore)];
    }

    /** Ends the open assistant message (and the open thought) of the session, or the open message of the sub-agent `agentId`, if there is one. */
    close(agentId?: string): EngineEvent[] {
        return agentId === undefined ? [...this.thought.close(), ...this.messageOf(agentId).close(agentId)] : this.messageOf(agentId).close(agentId);
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

            child = { name, message: new Message(), ended: false };
            this.children.set(agentId, child);
            events.push({ type: 'subagent', agentId, parentToolCallId: agentId, name, ...(description !== undefined && { description }), state: 'running' });
        }

        if (child.ended) {
            return this.drop(agentId, update);
        }

        switch (update.sessionUpdate) {
            case 'agent_message_chunk':
                if (update.content.type === 'text') {
                    events.push(...child.message.append(update.content.text, update.messageId ?? undefined, agentId));
                }

                break;
            case 'tool_call':
                events.push(...this.close(agentId), ...this.tool(update, agentId));
                break;
            case 'tool_call_update':
                events.push(...this.tool(update, agentId));
                break;
            default:
                // Its thoughts and plans are not shown; the window and the cost are the session's.
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

    /** A tool call of the session, or of the sub-agent `agentId`. */
    private tool(update: ToolCall | ToolCallUpdate, agentId?: string): EngineEvent[] {
        const event = this.tools.apply({ ...update, shown: shownOf(update.content) }, agentId);

        return event ? [event, ...this.settle(update.toolCallId)] : [];
    }

    /** The call that started a sub-agent ended, and so did the sub-agent: the call's result is its report. */
    private settle(id: string): EngineEvent[] {
        const call = this.tools.get(id);
        const child = this.children.get(id);

        if (!call || !child || child.ended || call.state === 'running') {
            return [];
        }

        const summary = call.state === 'error' ? call.error : call.output;
        const events = this.close(id);

        child.ended = true;
        events.push({ type: 'subagent', agentId: id, parentToolCallId: id, name: child.name, state: call.state, ...(summary !== undefined && { summary }) });

        return events;
    }
}
