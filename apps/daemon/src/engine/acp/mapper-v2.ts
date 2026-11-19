import { ContentBlock, SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk/experimental/v2/unstable';

import { COMPACT_TOOL, Gauges, Message, ToolLedger, usageEvent } from './mapper-core';

import type { CompactionUpdate, ToolCallUpdate, Usage } from '@agentclientprotocol/sdk/experimental/v2/unstable';
import type { EngineEvent } from '../types';
import type { MapperOptions } from './mapper';
import type { Json } from './mapper-core';

/** A terminal's output kept for the tool call that shows it: past this many bytes the rest is left out, since a result is cut long before. */
const MAX_TERMINAL_BYTES = 80_000;

/** The state of a tool call for each state a compaction is in; one the draft adds later is taken as still going. */
const COMPACTION_STATES: Record<string, string> = { in_progress: 'in_progress', completed: 'completed', failed: 'failed', cancelled: 'cancelled' };

/** What the updates of one tool call said so far. An update of ACP v2 patches the call, so a field it leaves out is what an earlier one said. */
interface Call {
    name?: string;
    title?: string;
    kind?: string;
    status?: string;
    rawInput?: unknown;
    rawOutput?: unknown;
    content: ToolCallContent[];
    meta?: Json;
}

/** `null` clears a field, an omitted one leaves it, a value replaces it. */
const patched = <T>(old: T | undefined, next: T | null | undefined): T | undefined => next === undefined ? old : next ?? undefined;

/** A patch of `_meta`: by top-level key, a key set to `null` is removed, and `null` clears all. */
function patchedMeta(old: Json | undefined, next: Json | null | undefined): Json | undefined {
    if (next === undefined) {
        return old;
    }

    if (next === null) {
        return undefined;
    }

    return Object.fromEntries(Object.entries({ ...old, ...next }).filter(([, value]) => value !== null));
}

/** The text of the text blocks among `content`, which an agent message holds as an array. */
const textOf = (content: ContentBlock[]): string => content.map(block => ContentBlock.isText(block) ? block.text : '').join('');

/**
 * Turns the `session/update`s of one prompt in ACP v2 into engine events, the ones `UpdateMapper` makes for v1: the shared parts (tool names and
 * states, results, the message as it streams, the numbers) are in `mapper-core.ts`, and this reads v2's shapes. One mapper per prompt.
 *
 * What differs from v1: a message has an id, and chunks append to it while a whole message replaces what it held (the stream only grows, so the part
 * that is new is what shows); there is no `tool_call`, the first `tool_call_update` of an id creates the call, and an update patches it; a terminal's
 * output arrives on its own and is shown as the result of a call that displays it. The turn's own lifecycle (`state_update`) is the layer's: the
 * mapper gets the updates of the session's own conversation and nothing else. A sub-agent is a session of its own in v2, whose updates the layer does
 * not pass on yet; plans, thoughts and modes are dropped as in v1.
 */
export class UpdateMapperV2 {
    private message = new Message();
    private tools: ToolLedger;
    private gauges: Gauges;
    private calls = new Map<string, Call>();
    private terminals = new Map<string, Buffer>();

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
        // The SDK's union keeps a catch-all for updates it does not know, so each kind is asked for by its guard.
        if (SessionUpdate.isAgentMessageChunk(update)) {
            return ContentBlock.isText(update.content) ? this.message.append(update.content.text, update.messageId) : [];
        }

        if (SessionUpdate.isAgentMessage(update)) {
            // An update with no content leaves the message as it is, and one that clears it cannot take back what was shown.
            return update.content ? this.message.upsert(update.messageId, textOf(update.content)) : [];
        }

        if (SessionUpdate.isToolCallUpdate(update)) {
            return this.tool(update);
        }

        if (SessionUpdate.isToolCallContentChunk(update)) {
            return this.tool({ toolCallId: update.toolCallId }, update.content);
        }

        if (SessionUpdate.isTerminalUpdate(update)) {
            this.print(update.terminalId, update.output?.data, 'replace');
        }
        else if (SessionUpdate.isTerminalOutputChunk(update)) {
            this.print(update.terminalId, update.data, 'append');
        }
        else if (SessionUpdate.isCompactionUpdate(update)) {
            return this.compaction(update);
        }
        else if (SessionUpdate.isUsageUpdate(update)) {
            return this.gauges.update(update);
        }

        // Thoughts, plans, commands, modes, titles, notices, and the background work of the session (a later stage reads it): nothing the runtime shows.
        return [];
    }

    /** The prompt ended: closes the open message and reports what the prompt used. */
    stop(usage: Usage | null | undefined): EngineEvent[] {
        return [...this.close(), ...usageEvent(usage, this.gauges.cost, this.options.costBefore)];
    }

    /** Ends the open assistant message, if there is one. */
    close(): EngineEvent[] {
        return this.message.close();
    }

    /** One update of a tool call, and the content item a chunk adds to it. The first update of an id is the call's start, which ends the message before it. */
    private tool(update: ToolCallUpdate, added?: ToolCallContent): EngineEvent[] {
        const id = update.toolCallId;
        const known = this.calls.get(id);
        const call: Call = {
            name: patched(known?.name, update.name),
            title: patched(known?.title, update.title),
            // Null resets what a call is to the protocol's default.
            kind: update.kind === null ? 'other' : update.kind ?? known?.kind,
            status: update.status === null ? 'pending' : update.status ?? known?.status,
            rawInput: update.rawInput === undefined ? known?.rawInput : update.rawInput,
            rawOutput: update.rawOutput === undefined ? known?.rawOutput : update.rawOutput,
            content: [...(update.content === undefined ? known?.content ?? [] : update.content ?? []), ...(added ? [added] : [])],
            meta: patchedMeta(known?.meta, update._meta),
        };

        this.calls.set(id, call);

        return [...(known ? [] : this.close()), ...this.show(id, call)];
    }

    private show(toolCallId: string, call: Call): EngineEvent[] {
        const event = this.tools.apply({ toolCallId, name: call.name, title: call.title, kind: call.kind, status: call.status, rawInput: call.rawInput, rawOutput: call.rawOutput, shown: this.shownOf(call.content), _meta: call.meta });

        return event ? [event] : [];
    }

    /** The text of the content a call showed: the text blocks, a diff as the files it changed, a terminal as the output it printed. */
    private shownOf(content: ToolCallContent[]): string | undefined {
        return content.map((item) => {
            if (ToolCallContent.isContent(item)) {
                return ContentBlock.isText(item.content) ? item.content.text : '';
            }

            if (ToolCallContent.isDiff(item)) {
                // A kind of change the draft adds later may name no path.
                return item.changes.flatMap(change => 'path' in change && typeof change.path === 'string' ? [`Changed ${ change.path }`] : []).join('\n');
            }

            return ToolCallContent.isTerminal(item) ? this.terminals.get(item.terminalId)?.toString('utf8') ?? '' : '';
        }).filter(Boolean).join('\n') || undefined;
    }

    /** What a terminal printed, as base64: the output of a call that shows it comes from here when the call completes. */
    private print(id: string, data: string | undefined, how: 'replace' | 'append'): void {
        if (data !== undefined) {
            const bytes = Buffer.from(data, 'base64');
            const kept = how === 'append' ? Buffer.concat([this.terminals.get(id) ?? Buffer.alloc(0), bytes]) : bytes;

            this.terminals.set(id, kept.subarray(0, MAX_TERMINAL_BYTES));
        }
    }

    /** A compaction the agent reports as its own kind of update (Claude's and Codex's adapters may report a tool call instead, which `tool` takes). */
    private compaction({ compactionId, status, error }: CompactionUpdate): EngineEvent[] {
        const id = `compaction-${ compactionId }`;
        const fresh = !this.calls.has(id);
        const call: Call = { name: COMPACT_TOOL, status: COMPACTION_STATES[status] ?? 'in_progress', ...(error && { rawOutput: error }), content: [] };

        this.calls.set(id, call);

        return [...(fresh ? this.close() : []), ...this.show(id, call)];
    }
}
