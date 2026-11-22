import { BackgroundWork, ContentBlock, IdleStateUpdate, StateUpdate } from '@agentclientprotocol/sdk/experimental/v2/unstable';
import { STOPPED_TOOL } from '@clowdy/protocol';

import { Message, patched, Thought } from './mapper-core';

import type { SessionMessage, SubagentUpdate } from '@agentclientprotocol/sdk/experimental/v2/unstable';
import type { EngineEvent } from '../types';

/** What a sub-agent is called when its parent says nothing of what kind it is. */
const FALLBACK_NAME = 'Sub-agent';

/** The name the stream shows the call that started a sub-agent by: the card of `Agent` is drawn from it (`SubagentCard`). */
const AGENT_CALL = 'Agent';

/** One sub-agent of the session: a session of its own, which its parent announced. */
interface Child {
    sessionId: string;
    /** The session that announced it: the id of another child, or `undefined` for the session the engine talks to. */
    parent?: string;
    /** What kind of sub-agent it is (Claude's `subagent_type`), as the parent describes it. */
    type?: string;
    /** The parent's name for the task. */
    title?: string;
    /** What the parent asked of it, the first message that went to it. */
    prompt?: string;
    /** The id of the call that started it: the id of the message that carried the prompt, which the child's own calls name as their parent. */
    callId?: string;
    /** The id its background item has had since the first list that named it: the call's, when it was known by then, else the session's. It does not change while the item is open. */
    itemId?: string;
    /** Its parent said the client may cancel its work (`subagent_update`'s `capabilities.cancel`); without it the protocol permits no request to the child. */
    cancellable: boolean;
    /** The runtime was told it exists (`subagent` `running`). Held until the call that started it is known, so the child run can name it. */
    announced: boolean;
    /** The child works: it said `running` or `requires_action` since its last stop. */
    working: boolean;
    /** The parent lists it among its background work now. */
    listed: boolean;
    /** Its run is over for good: a foreground sub-agent that stopped, or any that was cancelled or failed. */
    ended: boolean;
    /** The parent's list lost it after it stopped, so it has finished (its run is closed by the runtime from the snapshot) unless it wakes again. */
    settled: boolean;
    /** What the card of its call last said (its state, and the whole event), to say nothing twice. */
    card?: { state: 'running' | 'done' | 'error' | 'cancelled'; signature: string };
    /** What it says on its own, and the last message it sent its parent. */
    message: Message;
    /** What it thinks, which its run shows (its card in the parent's stream does not). */
    thought: Thought;
    report?: string;
}

/** The text of the text blocks among `content`, which an agent message holds as an array. */
export const textOf = (content: readonly ContentBlock[] | null | undefined): string => (content ?? []).map(block => ContentBlock.isText(block) ? block.text : '').join('');

/** Why a sub-agent that stopped for a reason other than an answer failed, for the card and the child run. */
function failureOf(state: IdleStateUpdate): string {
    if (IdleStateUpdate.isError(state)) {
        return state.error?.message || 'The sub-agent failed';
    }

    return `The sub-agent stopped: ${ String(state.stopReason).replace(/_/g, ' ') }`;
}

/**
 * The sub-agents of one v2 session. In v2 a sub-agent is a session of its own: the parent announces it (`subagent_update`), says what it asked of it and
 * hears its report as `session_message`s, and the child's own calls and messages come on its session. This turns that into what the runtime knows
 * from v1: a `subagent` event for the child run, the child's `text` and `tool` events with its `agentId`, and the call that started it as a card in
 * the parent's stream, which v2 does not show (an `Agent` call the parent announced a child for never reaches it).
 *
 * The card is made from what v2 does say: its id is the id of the message that carried the prompt (the child's calls name it as their parent), its
 * input the child's kind, the parent's title for the task and the prompt. It runs while the child works and ends with its report, so a card in the
 * stream of a parent that has gone on says what its sub-agent does, like a `Workflow` call.
 *
 * When a sub-agent ends depends on whether its parent lists it as background work. A foreground one ends when it stops. A background one that stops is
 * not over: its own background command may wake it a moment later (it stops, and runs again within a millisecond), so it ends when the parent no longer
 * lists it, which the runtime reads from the snapshot, and the layer only says it stopped (the card). A child that was cancelled or failed is over
 * either way.
 */
export class Children {
    private byId = new Map<string, Child>();

    /** `close` ends the open assistant message of a session (a child's, or the main one when `agentId` is none): a call that starts ends the message before it. */
    constructor(private close: (agentId?: string) => EngineEvent[]) {}

    has(sessionId: string): boolean {
        return this.byId.has(sessionId);
    }

    /**
     * The id of a sub-agent's background item: the id of the call that started it, which is also the `parentToolCallId` of its child run, so the app
     * can tell that the child run is the item (the strip lists it once). The session's id when no call is known. Once said it is not changed.
     */
    itemIdOf(sessionId: string): string {
        const child = this.byId.get(sessionId);

        if (!child) {
            return sessionId;
        }

        child.itemId ??= child.callId ?? sessionId;

        return child.itemId;
    }

    /** Whether the client may ask this sub-agent to stop: the parent announced it with the capability, and it is not over (it has not ended, and the list has not lost it after it stopped). */
    stoppable(sessionId: string): boolean {
        const child = this.byId.get(sessionId);

        return child !== undefined && child.cancellable && !child.ended && !child.settled;
    }

    /** What the parent calls the sub-agent: its title, else the kind it is. */
    titleOf(sessionId: string): string | undefined {
        const child = this.byId.get(sessionId);

        return child?.title || child?.type || undefined;
    }

    /**
     * The parent announces a child, or says more of one. The runtime hears of it once the call that started it is known (the next message to it, or the first
     * call it makes), so a child run is made once, with the call's id.
     */
    announce(update: SubagentUpdate, parent?: string): EngineEvent[] {
        let child = this.byId.get(update.sessionId);

        if (!child) {
            child = { sessionId: update.sessionId, ...(parent !== undefined && { parent }), cancellable: false, announced: false, working: false, listed: false, ended: false, settled: false, message: new Message(), thought: new Thought() };
            this.byId.set(update.sessionId, child);
        }

        const title = child.title;

        child.title = patched(child.title, update.title);
        child.type = patched(child.type, update.description);

        // What the parent permits the client to do with the child is replaced by what it says now: omitted keeps it, `null` or no `cancel` takes it away.
        if (update.capabilities !== undefined) {
            child.cancellable = update.capabilities?.cancel != null;
        }

        const events: EngineEvent[] = child.announced && child.title !== title && !child.ended ? this.describe(child) : [];

        if (update.state) {
            events.push(...this.moved(child, update.state));
        }

        return events;
    }

    /**
     * A message between sessions: what the parent asked of a child (its first one names the call), or what a child says to its parent (its report). Each
     * message comes twice, once on each session's view of it.
     */
    message(update: SessionMessage): EngineEvent[] {
        const text = textOf(update.content);
        const events: EngineEvent[] = [];
        const to = update.recipientSessionId ? this.byId.get(update.recipientSessionId) : undefined;
        const from = update.senderSessionId ? this.byId.get(update.senderSessionId) : undefined;

        // What a session asks of a child it started is that child's prompt, not the asker's report.
        const asked = to !== undefined && to.parent === from?.sessionId;

        if (to && to !== from) {
            to.prompt ??= text || undefined;
            to.callId ??= update.messageId;
            events.push(...this.show(to));
        }

        if (from && text && !asked) {
            // Its report is the last thing it says: it is shown in its own stream and ends the card.
            events.push(...this.show(from), ...from.thought.close(from.sessionId), ...from.message.upsert(update.messageId, text, from.sessionId), ...from.message.close(from.sessionId));
            from.report = text;
        }

        return events;
    }

    /** A child that has done something (a call, a message of its own) is known to the runtime, with a call to name it by if it stamped its calls with one. */
    heard(sessionId: string, callId?: string): EngineEvent[] {
        const child = this.byId.get(sessionId);

        if (!child) {
            return [];
        }

        child.callId ??= callId;

        return this.show(child);
    }

    /** What a child says on its own, as the message it speaks (its assistant message), or the one it has open to close. */
    messageOf(sessionId: string): Message | undefined {
        return this.byId.get(sessionId)?.message;
    }

    /** What a child thinks, as the thought it has open. */
    thoughtOf(sessionId: string): Thought | undefined {
        return this.byId.get(sessionId)?.thought;
    }

    /** The child's own state: the same thing its parent mirrors in `subagent_update`, said again on its session. */
    state(sessionId: string, state: StateUpdate): EngineEvent[] {
        const child = this.byId.get(sessionId);

        return child ? this.moved(child, state) : [];
    }

    /**
     * The parent's list of background work changed: a child it no longer lists has finished and its card says so. The run is closed by the runtime
     * from the snapshot, when nothing shows the child back, which a sub-agent woken by its own command does within a millisecond.
     */
    listed(work: readonly BackgroundWork[]): EngineEvent[] {
        const now = new Set(work.flatMap(item => BackgroundWork.isSubagent(item) ? [item.sessionId] : []));
        const events: EngineEvent[] = [];

        for (const child of this.byId.values()) {
            const was = child.listed;

            child.listed = now.has(child.sessionId);

            if (was && !child.listed && !child.ended && !child.working) {
                child.settled = true;
                events.push(...this.draw(child, 'done', child.report ?? child.message.result()));
            }
        }

        return events;
    }

    /** The child said something about what it is doing. */
    private moved(child: Child, state: StateUpdate): EngineEvent[] {
        if (child.ended) {
            return [];
        }

        if (StateUpdate.isRunning(state) || StateUpdate.isRequiresAction(state)) {
            const again = !child.working && child.card !== undefined && child.card.state !== 'running';

            child.working = true;
            child.settled = false;

            // A background sub-agent that woke for another turn is at work again.
            return again ? this.draw(child, 'running') : [];
        }

        // An `idle` with no reason is a snapshot of the state the child is in, not the end of a run.
        if (!StateUpdate.isIdle(state) || !state.stopReason) {
            return [];
        }

        child.working = false;

        switch (state.stopReason) {
            case 'end_turn':
                // A message it left open is over, whether or not the sub-agent is.
                return child.listed ? [...child.thought.close(child.sessionId), ...child.message.close(child.sessionId)] : this.end(child, 'done');
            case 'cancelled':
                return this.end(child, 'cancelled');
            default:
                return this.end(child, 'error', failureOf(state));
        }
    }

    /** The child's run is over: its own message closes, the card ends with its report, and the runtime is told. */
    private end(child: Child, state: 'done' | 'error' | 'cancelled', failure?: string): EngineEvent[] {
        const events = [...this.show(child), ...child.thought.close(child.sessionId), ...child.message.close(child.sessionId)];
        const report = child.report ?? child.message.result();

        child.ended = true;
        events.push(...this.draw(child, state, state === 'done' ? report : failure));
        events.push({
            type: 'subagent',
            agentId: child.sessionId,
            ...(child.parent !== undefined && { parentAgentId: child.parent }),
            ...(child.callId !== undefined && { parentToolCallId: child.callId }),
            name: child.type ?? FALLBACK_NAME,
            state,
            ...(state === 'done' ? report !== undefined && { summary: report } : failure !== undefined && { summary: failure }),
        });

        return events;
    }

    /** Tells the runtime the child exists (once), with its card. */
    private show(child: Child): EngineEvent[] {
        if (child.announced) {
            return [];
        }

        child.announced = true;

        return [...this.draw(child, 'running'), ...this.describe(child)];
    }

    /** The child's `running` event, again with a new description when its parent renamed the task. */
    private describe(child: Child): EngineEvent[] {
        return [{
            type: 'subagent',
            agentId: child.sessionId,
            ...(child.parent !== undefined && { parentAgentId: child.parent }),
            ...(child.callId !== undefined && { parentToolCallId: child.callId }),
            name: child.type ?? FALLBACK_NAME,
            ...(child.title !== undefined && { description: child.title }),
            state: 'running',
            ...(child.cancellable && { stoppable: true }),
        }];
    }

    /** The card of the call that started the child, as it stands: nothing when no call is known, or when it already says so. */
    private draw(child: Child, state: 'running' | 'done' | 'error' | 'cancelled', text?: string): EngineEvent[] {
        if (child.callId === undefined) {
            return [];
        }

        const event: EngineEvent = {
            type: 'tool',
            toolCallId: child.callId,
            name: AGENT_CALL,
            input: { ...(child.type && { subagent_type: child.type }), ...(child.title && { description: child.title }), ...(child.prompt && { prompt: child.prompt }) },
            state: state === 'running' ? 'running' : state === 'done' ? 'done' : 'error',
            ...(state === 'done' && text !== undefined && { output: text }),
            ...(state === 'error' && { error: text ?? 'The sub-agent failed' }),
            ...(state === 'cancelled' && { error: STOPPED_TOOL }),
            // A child of a child: the call is in its parent's stream.
            ...(child.parent !== undefined && { agentId: child.parent }),
        };
        const signature = JSON.stringify(event);

        if (signature === child.card?.signature) {
            return [];
        }

        child.card = { state, signature };

        return [...(state === 'running' ? this.close(child.parent) : []), event];
    }
}
