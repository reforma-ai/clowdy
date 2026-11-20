import { BackgroundWork, ContentBlock, SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk/experimental/v2/unstable';

import { Children, textOf } from './children';
import { COMPACT_TOOL, Gauges, isRecord, Message, patched, ToolLedger, usageEvent } from './mapper-core';

import type { CompactionUpdate, TerminalUpdate, ToolCallUpdate } from '@agentclientprotocol/sdk/experimental/v2/unstable';
import type { BackgroundItem } from '@clowdy/protocol';
import type { EngineEvent } from '../types';
import type { MapperOptions } from './mapper';
import type { Json, Tokens } from './mapper-core';

/** A terminal's output kept for the tool call that shows it: past this many bytes the rest is left out, since a result is cut long before. */
const MAX_TERMINAL_BYTES = 80_000;

/** A background item's title is cut here; the runtime bounds it again. */
const MAX_BACKGROUND_TITLE = 200;

/** The states in which a tool call is over. */
const FINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

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

/** What an item shows as its title: the text on one line and cut, or what the item is when nothing names it. */
function titled(text: string | null | undefined, fallback: string): string {
    const line = (text ?? '').replace(/\s+/g, ' ').trim();

    return line.length > MAX_BACKGROUND_TITLE ? `${ line.slice(0, MAX_BACKGROUND_TITLE - 1) }…` : line || fallback;
}

/**
 * Turns the `session/update`s of ACP v2 into engine events, the ones `UpdateMapper` makes for v1: the shared parts (tool names and
 * states, results, the message as it streams, the numbers) are in `mapper-core.ts`, and this reads v2's shapes.
 *
 * What differs from v1: a message has an id, and chunks append to it while a whole message replaces what it held (the stream only grows, so the part
 * that is new is what shows); there is no `tool_call`, the first `tool_call_update` of an id creates the call, and an update patches it; a terminal's
 * output arrives on its own and is shown as the result of a call that displays it. The turn's own lifecycle (`state_update`) is the layer's. A
 * sub-agent is a session of its own in v2: the layer passes on what the sessions it announced say, with the id of the session as `from`, and `Children`
 * (`children.ts`) turns them into a child run and the card of the call that started it; its calls and messages are mapped here, with the child's
 * `agentId`. Plans, thoughts and modes are dropped as in v1. A sub-agent's background item is named by the call that started it (see `itemIdOf`).
 *
 * One mapper serves a whole session, which may go on for many turns (a turn the agent starts on its own, a prompt sent into the live session): `stop`
 * ends one, `next` starts the following. `background` turns the session's list of open work into the items the runtime shows, named from what the
 * mapper heard of each (a terminal's command, a sub-agent's title, a tool call's title).
 */
export class UpdateMapperV2 {
    private message = new Message();
    private tools: ToolLedger;
    private gauges: Gauges;
    private calls = new Map<string, Call>();
    private terminals = new Map<string, Buffer>();
    /** The command of each terminal that said one. */
    private commands = new Map<string, string>();
    /** The terminals of the session that say the client may cancel them (`terminal/cancel`) and have not exited: a background command that can be stopped alone. */
    private cancellable = new Set<string>();
    /** The tool calls of the session that say the client may cancel them (`tool_call/cancel`) and have not ended: a background task (Claude's `Workflow`) that can be stopped alone. */
    private cancellableCalls = new Set<string>();
    /** The sub-agents of the session: sessions of their own, which the session announced. */
    private children = new Children(agentId => this.close(agentId));
    /** The session's cumulative cost at the end of the last turn: what the next turn's cost is measured from. */
    private costBefore?: number;
    /** The turn that follows a steer that landed may say the answer again: a message identical to the one before it is not shown twice. */
    private folding = false;
    /** The start of a message that may be that repeat, held back (Claude's adapter says it as one chunk) until it is clear whether it is. */
    private held?: { id: string; text: string };

    constructor(private options: MapperOptions) {
        this.tools = new ToolLedger(options.toolNames);
        this.gauges = new Gauges(options.log);
        this.costBefore = options.costBefore;
    }

    /** The session's cumulative cost in USD, as of the latest `usage_update`. */
    get cost(): number | undefined {
        return this.gauges.cost;
    }

    /** The text of the session's last assistant message so far: what `done` reports. */
    result(): string | undefined {
        return this.message.result();
    }

    /**
     * One update of the session, or of the sub-agent session `from` (which the session announced, and which this mapper knows by its `subagent_update`).
     * What a sub-agent says is its own: its messages and calls carry its `agentId`, and its numbers (window, cost) are not the session's.
     */
    update(update: SessionUpdate, from?: string): EngineEvent[] {
        if (from !== undefined) {
            return this.fromChild(from, update);
        }

        // The SDK's union keeps a catch-all for updates it does not know, so each kind is asked for by its guard.
        if (SessionUpdate.isAgentMessageChunk(update)) {
            return ContentBlock.isText(update.content) ? this.chunk(update.content.text, update.messageId) : [];
        }

        if (SessionUpdate.isAgentMessage(update)) {
            if (!update.content) {
                // An update with no content leaves the message as it is, and one that clears it cannot take back what was shown.
                return [];
            }

            const text = textOf(update.content);
            const settled = this.settle();

            return [...settled, ...(this.folding && this.message.repeats(update.messageId, text) ? [] : this.message.upsert(update.messageId, text))];
        }

        if (SessionUpdate.isToolCallUpdate(update)) {
            return this.tool(update);
        }

        if (SessionUpdate.isToolCallContentChunk(update)) {
            return this.tool({ toolCallId: update.toolCallId }, update.content);
        }

        if (SessionUpdate.isTerminalUpdate(update)) {
            if (update.command) {
                this.commands.set(update.terminalId, update.command);
            }

            this.permit(update);
            this.print(update.terminalId, update.output?.data, 'replace');
        }
        else if (SessionUpdate.isSubagentUpdate(update)) {
            return this.children.announce(update);
        }
        else if (SessionUpdate.isSessionMessage(update)) {
            return this.children.message(update);
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

        // Thoughts, plans, commands, modes, titles and notices: nothing the runtime shows. The background work of the session is `background`'s.
        return [];
    }

    /** The turn ended: closes the open message and reports what the turn used, the cost measured from where the turn before it left the session's. */
    stop(tokens: Tokens | null | undefined): EngineEvent[] {
        const events = [...this.close(), ...usageEvent(tokens, this.gauges.cost, this.costBefore)];

        this.costBefore = this.gauges.cost ?? this.costBefore;

        return events;
    }

    /** What the next turn is: its result is its own (the last message of an earlier turn is not), and a repeat of an answer is no longer expected. */
    next(): void {
        this.message.forget();
        this.folding = false;
    }

    /** A steer landed in the turn that just ended: the turn that follows is its own, and says the answer again as a whole message under another id. */
    expectRepeat(): void {
        this.folding = true;
    }

    /**
     * The items of the session's list of background work, each named from what the mapper heard of it: a terminal by its command, a sub-agent by its title,
     * a tool call (`Workflow`, `Monitor`) by its title. A kind of work the draft adds later names nothing the runtime could show and is left out.
     */
    background(list: readonly BackgroundWork[]): BackgroundItem[] {
        return list.flatMap((work): BackgroundItem[] => {
            if (BackgroundWork.isTerminal(work)) {
                return [{ id: work.terminalId, kind: 'command', title: titled(this.commands.get(work.terminalId), 'Background command'), ...(this.cancellable.has(work.terminalId) && { canStopAlone: true }) }];
            }

            if (BackgroundWork.isSubagent(work)) {
                return [{ id: this.children.itemIdOf(work.sessionId), kind: 'subagent', title: titled(this.children.titleOf(work.sessionId), 'Sub-agent') }];
            }

            if (BackgroundWork.isToolCall(work)) {
                return [{ id: work.toolCallId, kind: 'task', title: titled(this.calls.get(work.toolCallId)?.title || this.tools.get(work.toolCallId)?.name, 'Background task'), ...(this.cancellableCalls.has(work.toolCallId) && { canStopAlone: true }) }];
            }

            return [];
        });
    }

    /**
     * The tool calls that are still running and show a terminal the list names: the call of a command that outlived its turn, which Codex keeps running
     * until the command ends (Claude's `Bash` call completes at once). The runtime does not fail them when the turn ends.
     */
    openCalls(list: readonly BackgroundWork[]): string[] {
        const listed = new Set(list.flatMap(work => BackgroundWork.isTerminal(work) ? [work.terminalId] : []));

        return [...this.calls].filter(([, call]) => !FINAL_STATES.has(call.status ?? '') && call.content.some(item => ToolCallContent.isTerminal(item) && listed.has(item.terminalId))).map(([id]) => id);
    }

    /**
     * The session's list of background work changed: a sub-agent it no longer lists has finished, and the card of its call says so. The layer asks
     * after each list, before it tells the runtime the list.
     */
    listed(list: readonly BackgroundWork[]): EngineEvent[] {
        return this.children.listed(list);
    }

    /** Whether `sessionId` is a sub-agent this mapper knows: an announced session, whose updates `update` takes with it as `from`. */
    knows(sessionId: string): boolean {
        return this.children.has(sessionId);
    }

    /** Whether the client may ask the sub-agent `sessionId` to stop: announced with the permission to, and not ended. */
    stoppable(sessionId: string): boolean {
        return this.children.stoppable(sessionId);
    }

    /** Whether the client may ask the agent to cancel the terminal `terminalId`: it said so and has not reported the terminal exited. */
    stoppableCommand(terminalId: string): boolean {
        return this.cancellable.has(terminalId);
    }

    /** Whether the client may ask the agent to cancel the tool call `toolCallId`: it said so and has not ended the call. */
    stoppableTask(toolCallId: string): boolean {
        return this.cancellableCalls.has(toolCallId);
    }

    /**
     * What a terminal says the client may do with it: `capabilities.cancel` (an object, even an empty one) lets the client cancel it; omitted leaves it as
     * it was, `null` takes it away, and an exit status ends it ("Agents SHOULD stop advertising it" then, but a cancelled terminal is no longer one to cancel
     * whatever they say).
     */
    private permit({ terminalId, capabilities, exitStatus }: TerminalUpdate): void {
        if (capabilities !== undefined) {
            if (capabilities?.cancel != null) {
                this.cancellable.add(terminalId);
            }
            else {
                this.cancellable.delete(terminalId);
            }
        }

        if (exitStatus) {
            this.cancellable.delete(terminalId);
        }
    }

    /** One update of a sub-agent's session. Its first sign of life tells the runtime it exists, with the call that started it when its calls name one. */
    private fromChild(agentId: string, update: SessionUpdate): EngineEvent[] {
        if (!this.children.has(agentId)) {
            return [];
        }

        if (SessionUpdate.isStateUpdate(update)) {
            return this.children.state(agentId, update);
        }

        if (SessionUpdate.isSubagentUpdate(update)) {
            // A sub-agent of its own: announced by the child that started it.
            return this.children.announce(update, agentId);
        }

        if (SessionUpdate.isSessionMessage(update)) {
            return this.children.message(update);
        }

        const stamp = (update as { _meta?: Json | null })._meta?.claudeCode;
        const parentToolUseId = isRecord(stamp) && typeof stamp.parentToolUseId === 'string' ? stamp.parentToolUseId : undefined;
        const message = this.children.messageOf(agentId) as Message;

        if (SessionUpdate.isAgentMessageChunk(update)) {
            return ContentBlock.isText(update.content) ? [...this.children.heard(agentId, parentToolUseId), ...message.append(update.content.text, update.messageId, agentId)] : [];
        }

        if (SessionUpdate.isAgentMessage(update)) {
            return update.content ? [...this.children.heard(agentId, parentToolUseId), ...message.upsert(update.messageId, textOf(update.content), agentId)] : [];
        }

        if (SessionUpdate.isToolCallUpdate(update)) {
            return [...this.children.heard(agentId, parentToolUseId), ...this.tool(update, undefined, agentId)];
        }

        if (SessionUpdate.isToolCallContentChunk(update)) {
            return this.tool({ toolCallId: update.toolCallId }, update.content, agentId);
        }

        // What a child prints on a terminal is shown by the call that holds the terminal.
        if (SessionUpdate.isTerminalUpdate(update)) {
            if (update.command) {
                this.commands.set(update.terminalId, update.command);
            }

            this.print(update.terminalId, update.output?.data, 'replace');
        }
        else if (SessionUpdate.isTerminalOutputChunk(update)) {
            this.print(update.terminalId, update.data, 'append');
        }

        // Its thoughts, plans, options and numbers: nothing the runtime shows (the window and the cost are the session's).
        return [];
    }

    /** Ends the open assistant message of the session, or of the sub-agent `agentId`, if there is one. */
    close(agentId?: string): EngineEvent[] {
        if (agentId !== undefined) {
            return this.children.messageOf(agentId)?.close(agentId) ?? [];
        }

        return [...this.settle(), ...this.message.close()];
    }

    /**
     * Adds a chunk to its message. After a steer that landed, a message with a new id that so far says what the last message said is held back until it
     * ends: Claude's adapter gives the turn that answers the steer as one chunk with the whole answer again, which is no new message. One that goes
     * on differently is shown at once, with what was held.
     */
    private chunk(delta: string, messageId: string): EngineEvent[] {
        const settled = this.held && this.held.id !== messageId ? this.settle() : [];

        if (this.held || (this.folding && this.message.mayRepeat(messageId))) {
            const text = (this.held?.text ?? '') + delta;

            if (this.message.startsLast(text)) {
                this.held = { id: messageId, text };

                return settled;
            }

            this.held = undefined;

            return [...settled, ...this.message.append(text, messageId)];
        }

        return [...settled, ...this.message.append(delta, messageId)];
    }

    /** What was held back is over: a repeat of the last message adds nothing, anything else is a message, shown now. */
    private settle(): EngineEvent[] {
        const { held } = this;

        this.held = undefined;

        return held && !this.message.repeats(held.id, held.text) ? this.message.append(held.text, held.id) : [];
    }

    /** One update of a tool call, and the content item a chunk adds to it. The first update of an id is the call's start, which ends the message before it. */
    private tool(update: ToolCallUpdate, added?: ToolCallContent, agentId?: string): EngineEvent[] {
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

        // What a call of the session says the client may do with it (`capabilities.cancel`: an object, even an empty one, lets the client cancel it; a call that
        // ended cannot be, whatever the agent still advertises). A sub-agent's calls are its own.
        if (agentId === undefined) {
            if (update.capabilities !== undefined) {
                if (update.capabilities?.cancel != null) {
                    this.cancellableCalls.add(id);
                }
                else {
                    this.cancellableCalls.delete(id);
                }
            }

            if (FINAL_STATES.has(call.status ?? '')) {
                this.cancellableCalls.delete(id);
            }
        }

        return [...(known ? [] : this.close(agentId)), ...this.show(id, call, agentId)];
    }

    private show(toolCallId: string, call: Call, agentId?: string): EngineEvent[] {
        const event = this.tools.apply({ toolCallId, name: call.name, title: call.title, kind: call.kind, status: call.status, rawInput: call.rawInput, rawOutput: call.rawOutput, shown: this.shownOf(call.content), _meta: call.meta }, agentId);

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
