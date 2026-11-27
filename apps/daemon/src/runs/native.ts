import { isTerminalRunStatus } from '@clowdy/protocol';

import { getChat } from '../db/chats';
import { appendItem } from '../domain/items';
import { errorMessage } from '../errors';
import { TurnWriter } from './writer';

import type { BackgroundItem, MessageSource, Run } from '@clowdy/protocol';
import type { EngineEvent, SubagentState } from '../engine/types';
import type { Store } from '../store';
import type { RunService } from './service';

/** More sub-agents than this in one turn are counted, not listed: a workflow can start hundreds. */
const MAX_AGENTS = 300;
/** Events of sub-agents are applied together, at most this long after they arrive, in one transaction. */
const BATCH_MS = 30;
/** A sub-agent's text reaches the log less often than the parent's: there may be many at once. */
const TEXT_THROTTLE_MS = 250;

type SubagentEvent = Extract<EngineEvent, { type: 'subagent' }>;
type StreamEvent = Extract<EngineEvent, { type: 'text' | 'tool' | 'thought' }> & { agentId: string };

interface Agent {
    run: Run;
    /** The sub-agent that started it, when it is one of a sub-agent (its run is below that one's, and lives as long as that one is listed). */
    parentAgentId?: string;
    writer: TurnWriter;
    /** What its parent asked of it has been dealt with: written as the first item of its stream, or left out because the stream had an item already. */
    briefed?: boolean;
    /** Its item has been in a snapshot: from then on the item leaving the snapshot is the end of the sub-agent. */
    seen?: boolean;
    /** Its item is not in the snapshot any more, and nothing has said it ended otherwise. It ends when `settle` says the item stayed away. */
    left?: boolean;
    /** What it said: the message that is open and the last one that was closed, which is its result when it ends without one. */
    open?: string;
    last?: string;
    /** Someone asked the session to end it alone (`stop`), and why: the reason its run shows if the agent says it was cancelled. */
    stopReason?: string;
}

/**
 * The sub-agents inside one turn of a run's engine session (an agent's own `Agent` or `Task`, where the engine reports them), shown as child runs
 * with `origin: 'native'`. They have no process and take no slot; their stream is the text and tool events that carry
 * their `agentId`. Events arrive in bursts, so they are queued and written in one transaction per batch.
 */
export class NativeAgents {
    private agents = new Map<string, Agent>();
    private queue: (() => void)[] = [];
    private timer?: ReturnType<typeof setTimeout>;
    private skipped = new Set<string>();
    /** Sub-agents that `finish` ended and forgot: what they say after that is dropped, not taken for a new sub-agent. */
    private gone = new Set<string>();
    /** The ids of the `subagent` items in the latest background snapshot. */
    private listed = new Set<string>();

    /** `canStop` says whether the session can end one sub-agent alone (it has `EngineSession.stopItem`), asked each time a sub-agent is made: the session exists only after this. */
    constructor(
        private store: Store,
        private runs: RunService,
        private parent: Run,
        private canStop: () => boolean = () => false
    ) {}

    /** A sub-agent started, changed or ended. */
    state(event: SubagentEvent): void {
        this.push(() => this.applyState(event));
    }

    /** Text, a thought or a tool call of a sub-agent. */
    stream(event: StreamEvent): void {
        this.push(() => this.applyStream(event));
    }

    /**
     * The session's latest complete list of what it has open in the background. A sub-agent whose item was in a list ends when its item is not in
     * the latest one; `settle` says it stayed away (an item that comes back within a moment is the same sub-agent: its agent woke it again).
     */
    background(items: BackgroundItem[]): void {
        this.push(() => this.applyBackground(items));
    }

    /** What the snapshots lost stayed away: the sub-agents whose items are gone have ended. */
    settle(): void {
        this.push(() => this.applySettle());
    }

    /**
     * The id (`agentId`) of the running sub-agent whose child run is `runId`: the one a session is asked to end alone. `undefined` when this session has
     * no running sub-agent by that run (it ended, or belongs to another turn).
     */
    agentOf(runId: string): string | undefined {
        this.flush();

        return [...this.agents].find(([, agent]) => agent.run.id === runId && this.isRunning(agent))?.[0];
    }

    /**
     * The session was asked to end the sub-agent `agentId` alone. The sub-agent ends as the agent says (usually `cancelled`, through its `subagent` event);
     * `reason` is what its run shows then, the person's Stop, in place of the engine's wording.
     */
    stopped(agentId: string, reason: string): void {
        const agent = this.agents.get(agentId);

        if (agent) {
            agent.stopReason = reason;
        }
    }

    /** Whether the sub-agent that `item` (a `subagent` item of the background list) names was ended by a Stop of its own, not by finishing. */
    wasStopped(item: BackgroundItem): boolean {
        this.flush();

        return [...this.agents].some(
            ([agentId, agent]) =>
                (agentId === item.id || agent.run.parentToolCallId === item.id) &&
                agent.stopReason !== undefined &&
                this.runs.statusOf(agent.run.id) === 'cancelled'
        );
    }

    /** Whether `toolCallId` is the call that started a sub-agent, which the engine draws a card for: a call the sub-agent's state is, not something the agent did. */
    isCard(toolCallId: string): boolean {
        return [...this.agents.values()].some(agent => agent.run.parentToolCallId === toolCallId);
    }

    /**
     * The calls that started the sub-agents whose items are in the latest snapshot: the cards of those calls go on after the turn that began them, so
     * the turn's end does not fail them.
     */
    openCalls(): Set<string> {
        this.flush();

        return new Set(
            [...this.agents].flatMap(([agentId, agent]) =>
                agent.run.parentToolCallId !== undefined && this.isListed(agentId, agent)
                    ? [agent.run.parentToolCallId]
                    : []
            )
        );
    }

    /**
     * The parent's turn ended: whatever still runs ends with it, and so does a call a sub-agent left running (`reason` says why), also in a sub-agent
     * that a Stop of the parent has ended already. With `keepOpen` (the session goes on waiting for background work) a sub-agent whose item is still in
     * the latest snapshot goes on too, with its stream and its calls: it ends when its item leaves the snapshot, or with the next `finish` that does not
     * keep it. The item is matched by the id of the sub-agent or of the call that started it (`parentToolCallId`), which an engine must use as the item's
     * id; a sub-agent no item names is cancelled as before.
     */
    finish(reason?: string, keepOpen = false): void {
        this.flush();
        this.store.tx(() => {
            for (const [agentId, agent] of this.agents) {
                if (keepOpen && this.isListed(agentId, agent)) {
                    continue;
                }

                agent.writer.finish(reason);

                // Its item went away before the turn ended: it finished, whatever the turn does.
                if (agent.left) {
                    this.close(agent, 'done', agent.last);
                } else {
                    this.close(agent, 'cancelled', 'The parent run ended its turn');
                }

                this.agents.delete(agentId);
                this.gone.add(agentId);
            }

            if (this.skipped.size > 0) {
                this.runs.note(this.parent.id, `${this.skipped.size} more sub-agents ran and are not listed here`);
                this.skipped.clear();
            }
        });
    }

    private push(apply: () => void): void {
        this.queue.push(apply);
        this.timer ??= setTimeout(() => this.flush(), BATCH_MS);
    }

    private flush(): void {
        clearTimeout(this.timer);
        this.timer = undefined;

        const batch = this.queue.splice(0);

        if (batch.length === 0) {
            return;
        }

        this.store.tx(() => {
            for (const apply of batch) {
                try {
                    apply();
                } catch (error) {
                    console.error(
                        `[clowdy] a sub-agent event of ${this.parent.id} was dropped: ${errorMessage(error)}`
                    );
                }
            }
        });
    }

    private open(
        agentId: string,
        name: string,
        more: Pick<SubagentEvent, 'description' | 'parentToolCallId' | 'parentAgentId' | 'prompt'> & {
            canStopAlone?: boolean;
        } = {}
    ): Agent | undefined {
        const { description, parentToolCallId, parentAgentId, canStopAlone } = more;

        if (this.gone.has(agentId)) {
            return undefined;
        }

        if (this.agents.size >= MAX_AGENTS) {
            this.skipped.add(agentId);

            return undefined;
        }

        // A sub-agent of a sub-agent is a child run of that one's run, so the tree shows who started whom; one whose starter is not known (it was cut off by the cap) hangs from the session's run.
        const starter = parentAgentId === undefined ? undefined : this.agents.get(parentAgentId);
        const run = this.runs.createNative(starter?.run ?? this.parent, {
            name,
            summary: description ?? name,
            parentToolCallId,
            canStopAlone,
        });
        const agent: Agent = {
            run,
            writer: new TurnWriter(this.store, run, TEXT_THROTTLE_MS),
            ...(starter && { parentAgentId }),
        };

        // The list may have named it before its first event came.
        agent.seen = this.isListed(agentId, agent);
        this.agents.set(agentId, agent);
        this.brief(agent, more.prompt);

        return agent;
    }

    /**
     * Writes what the parent asked of the sub-agent as the first item of its stream, the way a thread's first message is written: a `user` item from the
     * chat whose orchestrator is the root of the tree (also for a sub-agent of a sub-agent, which names the chat and not its starter). Nothing is written
     * for a sub-agent that has no prompt, or already has an item: a prompt that comes later is not put in front of what the sub-agent has done.
     */
    private brief(agent: Agent, prompt?: string): void {
        if (agent.briefed || prompt === undefined) {
            return;
        }

        const chatId = this.runs.require(this.parent.rootRunId).chatId;
        const chat = chatId === undefined ? undefined : getChat(this.store.db, chatId);

        if (chat) {
            const from: MessageSource = { kind: 'thread', chatId: chat.id, title: chat.title };

            agent.writer.brief(prompt, from);
            agent.briefed = true;
        }
    }

    private applyBackground(items: BackgroundItem[]): void {
        this.listed = new Set(items.filter(item => item.kind === 'subagent').map(item => item.id));

        for (const [agentId, agent] of this.agents) {
            if (this.isListed(agentId, agent)) {
                agent.seen = true;
                agent.left = false;
            } else if (agent.seen) {
                // Its item is gone: it finished, unless the item is back before anything else happens. A failure or a cancel was reported by its own
                // `subagent` event, which closed it already.
                agent.left = true;
            }
        }
    }

    private applySettle(): void {
        // An ended sub-agent stays known until the turn's end, so what it says after it is dropped, not taken for a new sub-agent.
        for (const agent of this.agents.values()) {
            if (agent.left) {
                agent.left = false;
                this.close(agent, 'done', agent.last);
            }
        }
    }

    /** Whether the latest list names the sub-agent, or the one that started it: a sub-agent of a listed sub-agent is part of that open work, which the list does not spell out. */
    private isListed(agentId: string, agent: Agent): boolean {
        if (
            this.listed.has(agentId) ||
            (agent.run.parentToolCallId !== undefined && this.listed.has(agent.run.parentToolCallId))
        ) {
            return true;
        }

        const starter = agent.parentAgentId === undefined ? undefined : this.agents.get(agent.parentAgentId);

        return starter !== undefined && this.isListed(agent.parentAgentId as string, starter);
    }

    private applyState(event: SubagentEvent): void {
        const agent =
            this.agents.get(event.agentId) ??
            this.open(event.agentId, event.name, { ...event, canStopAlone: event.stoppable && this.canStop() });

        if (!agent || !this.isRunning(agent)) {
            return;
        }

        if (event.state === 'running') {
            if (event.description && event.description !== agent.run.summary) {
                this.runs.describe(agent.run.id, event.description);
                agent.run = { ...agent.run, summary: event.description };
            }

            this.brief(agent, event.prompt);

            return;
        }

        this.close(
            agent,
            event.state,
            event.state === 'cancelled' ? (agent.stopReason ?? event.summary) : event.summary
        );
    }

    private applyStream(event: StreamEvent): void {
        const agent = this.agents.get(event.agentId) ?? this.open(event.agentId, 'Sub-agent');

        if (!agent || !this.isRunning(agent)) {
            return;
        }

        if (event.type === 'text') {
            agent.open = (agent.open ?? '') + event.delta;

            if (event.done) {
                agent.last = agent.open.trim() || agent.last;
                agent.open = undefined;
            }

            agent.writer.text(event.delta, event.done);
        } else if (event.type === 'thought') {
            agent.writer.reasoning(event.delta, event.done);
        } else {
            agent.writer.tool(event);
        }
    }

    /** A sub-agent the user or the parent's cancellation already ended stays as it is. */
    private isRunning(agent: Agent): boolean {
        return !isTerminalRunStatus(this.runs.statusOf(agent.run.id));
    }

    private close(agent: Agent, state: Exclude<SubagentState, 'running'>, summary?: string): void {
        if (!this.isRunning(agent)) {
            return;
        }

        // A call the sub-agent left running ends with it.
        agent.writer.finish();

        // A failure is the last line of its stream, as a failed thread's is, so its page says it too: the card of its call in the parent's stream is not the only place.
        if (state === 'error')
            appendItem(this.store, agent.run.id, { kind: 'error', text: summary ?? 'The sub-agent failed' });

        if (state === 'done') {
            this.runs.setStatus(agent.run.id, 'succeeded', { result: summary });
        } else if (state === 'error') {
            this.runs.setStatus(agent.run.id, 'failed', { error: summary ?? 'The sub-agent failed' });
        } else {
            this.runs.setStatus(agent.run.id, 'cancelled', { reason: summary ?? 'The sub-agent was cancelled' });
        }
    }
}
