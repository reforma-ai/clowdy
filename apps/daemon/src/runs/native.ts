import { isTerminalRunStatus } from '@clowdy/protocol';

import { errorMessage } from '../errors';
import { TurnWriter } from './writer';

import type { BackgroundItem, Run } from '@clowdy/protocol';
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
type StreamEvent = Extract<EngineEvent, { type: 'text' | 'tool' }> & { agentId: string };

interface Agent {
    run: Run;
    writer: TurnWriter;
    /** It outlived the end of a turn because its background item was still open: the item leaving the snapshot ends it. */
    kept?: boolean;
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
    /** The ids of the `subagent` items in the latest background snapshot. */
    private listed = new Set<string>();

    constructor(private store: Store, private runs: RunService, private parent: Run) {}

    /** A sub-agent started, changed or ended. */
    state(event: SubagentEvent): void {
        this.push(() => this.applyState(event));
    }

    /** Text or a tool call of a sub-agent. */
    stream(event: StreamEvent): void {
        this.push(() => this.applyStream(event));
    }

    /** The session's latest complete list of what it has open in the background; a sub-agent that was kept past a turn's end ends once its item is gone. */
    background(items: BackgroundItem[]): void {
        this.push(() => this.applyBackground(items));
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
                    agent.kept = true;

                    continue;
                }

                agent.writer.finish(reason);
                this.close(agent, 'cancelled', 'The parent run ended its turn');
                this.agents.delete(agentId);
            }

            if (this.skipped.size > 0) {
                this.runs.note(this.parent.id, `${ this.skipped.size } more sub-agents ran and are not listed here`);
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
                }
                catch (error) {
                    console.error(`[clowdy] a sub-agent event of ${ this.parent.id } was dropped: ${ errorMessage(error) }`);
                }
            }
        });
    }

    private open(agentId: string, name: string, description?: string, parentToolCallId?: string): Agent | undefined {
        if (this.agents.size >= MAX_AGENTS) {
            this.skipped.add(agentId);

            return undefined;
        }

        const run = this.runs.createNative(this.parent, { name, summary: description ?? name, parentToolCallId });
        const agent: Agent = { run, writer: new TurnWriter(this.store, run.id, TEXT_THROTTLE_MS) };

        this.agents.set(agentId, agent);

        return agent;
    }

    private applyBackground(items: BackgroundItem[]): void {
        this.listed = new Set(items.filter(item => item.kind === 'subagent').map(item => item.id));

        for (const [agentId, agent] of this.agents) {
            if (agent.kept && !this.isListed(agentId, agent)) {
                // Its item is gone: it finished. A failure or a cancel was reported by its own `subagent` event, which closed it already.
                this.close(agent, 'done');
                this.agents.delete(agentId);
            }
        }
    }

    private isListed(agentId: string, agent: Agent): boolean {
        return this.listed.has(agentId) || (agent.run.parentToolCallId !== undefined && this.listed.has(agent.run.parentToolCallId));
    }

    private applyState(event: SubagentEvent): void {
        const agent = this.agents.get(event.agentId) ?? this.open(event.agentId, event.name, event.description, event.parentToolCallId);

        if (!agent || !this.isRunning(agent)) {
            return;
        }

        if (event.state === 'running') {
            if (event.description && event.description !== agent.run.summary) {
                this.runs.describe(agent.run.id, event.description);
                agent.run = { ...agent.run, summary: event.description };
            }

            return;
        }

        this.close(agent, event.state, event.summary);
    }

    private applyStream(event: StreamEvent): void {
        const agent = this.agents.get(event.agentId) ?? this.open(event.agentId, 'Sub-agent');

        if (!agent || !this.isRunning(agent)) {
            return;
        }

        if (event.type === 'text') {
            agent.writer.text(event.delta, event.done);
        }
        else {
            agent.writer.tool(event);
        }
    }

    /** A sub-agent the user or the parent's cancellation already ended stays as it is. */
    private isRunning(agent: Agent): boolean {
        return !isTerminalRunStatus(this.runs.require(agent.run.id).status);
    }

    private close(agent: Agent, state: Exclude<SubagentState, 'running'>, summary?: string): void {
        if (!this.isRunning(agent)) {
            return;
        }

        // A call the sub-agent left running ends with it.
        agent.writer.finish();

        if (state === 'done') {
            this.runs.setStatus(agent.run.id, 'succeeded', { result: summary });
        }
        else if (state === 'error') {
            this.runs.setStatus(agent.run.id, 'failed', { error: summary ?? 'The sub-agent failed' });
        }
        else {
            this.runs.setStatus(agent.run.id, 'cancelled', { reason: summary ?? 'The sub-agent was cancelled' });
        }
    }
}
