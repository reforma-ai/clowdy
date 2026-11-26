import { basename } from '@clowdy/lib';
import { STOPPED_TOOL } from '@clowdy/protocol';

import { COMPACT_TOOL } from './compaction';
import { describeTool, firstString } from './toolView';

import type { Chat, Run, StreamItem, StreamItemBody, ThreadOutcome } from '@clowdy/protocol';

type ToolBody = Extract<StreamItemBody, { kind: 'tool' }>;

/** The tools agents start their own sub-agents with: Claude's `Agent` (once `Task`), Codex's `spawnAgent`, and the common `spawn_subagent`. */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task', 'spawnAgent', 'spawn_subagent']);

export const isSubagentTool = (name: string): boolean => SUBAGENT_TOOLS.has(name);

/** What people call an agent type whose id says it badly. */
const LABELS: Record<string, string> = { 'general-purpose': 'General' };

/** The verb a running agent of a known type gets instead of `Running <Label>`. */
const LIVE_VERBS: Record<string, string> = { explore: 'Exploring', plan: 'Planning', verify: 'Verifying' };

/** How the card names a sub-agent: its type (Claude's `subagent_type`, `Explore`) or name, capitalized; nothing when the call names none. */
export function subagentLabel(name: string | undefined): string | undefined {
    const id = name?.trim();

    if (!id) return undefined;

    return LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/** What a sub-agent was asked to do: the one line its agent gave it (`Run.summary`), on a single line; nothing when it gave none. */
export function agentPurpose(run: Pick<Run, 'summary'>): string | undefined {
    const purpose = run.summary.replace(/\s+/g, ' ').trim();

    return purpose === '' ? undefined : purpose;
}

/** The agent type a sub-agent call asks for, from its input: Claude's `subagent_type` or `name`, Codex's and others' `agent_type`. */
export function subagentName(input: unknown): string | undefined {
    return firstString(input, ['name', 'subagent_type', 'agent_type', 'agentType']);
}

/** The label as a name: `General` is `General agent`, and a label that already says agent stays as it is. */
const asAgent = (label: string): string => (/agent$/i.test(label) ? label : `${label} agent`);

/** The name of a sub-agent that was given no purpose: a verb while it works, then its type as a name (`Explore agent`, `General agent`, as the banner, the header and the list say it). */
export function subagentTitle(label: string | undefined, live: boolean): string {
    if (!live) return label ? asAgent(label) : 'Agent';

    if (!label) return 'Running agent';

    return LIVE_VERBS[label.toLowerCase()] ?? `Running ${asAgent(label)}`;
}

/** The verbs of `describeTool` as a sub-agent's activity says them, with the thing it works on after them. */
const ACTIVITY_VERBS: Record<string, string> = {
    'Reading file': 'Reading',
    'Editing file': 'Editing',
    'Writing file': 'Writing',
    'Finding files': 'Finding',
};

/** One tool call as a line of activity: `Reading form.tsx`, `Searching useBookingPrice`, `Running bun test`, `Using Task get`. */
export function toolActivity(name: string, input: unknown): string {
    if (name === COMPACT_TOOL) return 'Compacting context';

    const view = describeTool(name, input);
    const target = view.target && (view.icon === 'file' || view.icon === 'code') ? basename(view.target) : view.target;

    if (view.icon === 'terminal') return target ? `Running ${target}` : 'Running a command';

    if (view.icon === 'tool') return `Using ${view.verb}`;

    const verb = ACTIVITY_VERBS[view.verb] ?? view.verb;

    return target ? `${verb} ${target}` : view.verb;
}

/**
 * What a working agent is doing, from the latest item of its stream: the tool it calls, `Finishing reply` while it writes, `Thinking…`
 * between a message and its next step, `Waiting for you` on a question. Nothing before it has done anything of its own.
 */
export function activityOf(body: StreamItemBody | undefined): string | undefined {
    switch (body?.kind) {
        case 'tool':
            return toolActivity(body.name, body.input);
        case 'assistant':
            return body.done ? 'Thinking…' : 'Finishing reply';
        case 'question':
            return body.answer === undefined ? 'Waiting for you' : undefined;
        default:
            return undefined;
    }
}

/** The latest item of a stream that says what its agent is doing: notes and errors are about it, not by it, and its thoughts are left out (the card says the operation, not the musing). */
export function latestActivity(items: readonly StreamItem[]): string | undefined {
    for (let index = items.length - 1; index >= 0; index--) {
        const { body } = items[index];

        if (body.kind === 'tool' || body.kind === 'assistant' || body.kind === 'question' || body.kind === 'user')
            return activityOf(body);
    }

    return undefined;
}

/** The line under a working sub-agent's name: what it does now, `Starting…` before its first step. */
export function agentActivityLine(activity?: string): string {
    return activity ?? 'Starting…';
}

/**
 * How a sub-agent ended, in the words a thread's notice says it (`finished`, `failed`, `was interrupted`); nothing while it works. A call that never ended is
 * interrupted (`stalled`: its run is over, or its child ended with the turn), as is one the person stopped; the child run's status settles a call that only says it failed.
 */
export function agentOutcome(
    call: Pick<ToolBody, 'state' | 'error'>,
    child: Pick<Run, 'status'> | undefined,
    stalled: boolean
): ThreadOutcome | undefined {
    if (stalled) return 'interrupted';

    if (call.state === 'running') return undefined;

    if (call.state === 'done') return 'finished';

    const stopped = call.error === STOPPED_TOOL || child?.status === 'cancelled' || child?.status === 'interrupted';

    return stopped ? 'interrupted' : 'failed';
}

/** What a sub-agent that stopped reports: the child's last words when it finished, why it failed when it did; an interrupted one says nothing more than the title does. */
export function agentReport(
    outcome: ThreadOutcome | undefined,
    call: Pick<ToolBody, 'error'>,
    child: Pick<Run, 'result' | 'error'> | undefined
): string | undefined {
    const text =
        outcome === 'finished' ? child?.result : outcome === 'failed' ? (child?.error ?? call.error) : undefined;

    return text?.trim() || undefined;
}

/** The native child a sub-agent call started: the run of the project that names the call as its `parentToolCallId`. */
export function childOfCall(runs: Iterable<Run>, toolCallId: string): Run | undefined {
    let found: Run | undefined;

    for (const run of runs) {
        // Tool call ids are the agent's own, unique in practice; the newest run wins should two ever share one.
        if (run.parentToolCallId === toolCallId && (!found || run.createdAt >= found.createdAt)) found = run;
    }

    return found;
}

/** What a sub-agent call asked of the sub-agent: Claude's `prompt` (which the synthetic call of ACP v2 carries too), or the `message` of Codex's spawn call. */
export function callPrompt(input: unknown): string | undefined {
    return firstString(input, ['prompt', 'message'])?.trim() || undefined;
}

/** Whether a stream begins with what its parent asked of it: the first message of a thread, which is also the first item of a native sub-agent's stream. */
export function beginsWithPrompt(items: readonly StreamItem[]): boolean {
    const body = items[0]?.body;

    return body?.kind === 'user' && body.from?.kind === 'thread';
}

/**
 * The first message of a native sub-agent's page when its stream has none (one stored before the daemon wrote it): what its parent asked, from the call that started it in the
 * parent's stream, from the chat that runs it. Nothing when the call is not there, has no prompt, or the chat is unknown. It is drawn, never stored.
 */
export function promptItemOf(
    run: Pick<Run, 'id' | 'parentToolCallId' | 'startedAt' | 'createdAt'>,
    parentItems: readonly StreamItem[],
    chat: Pick<Chat, 'id' | 'title'> | undefined
): StreamItem | undefined {
    if (!run.parentToolCallId || !chat) return undefined;

    const call = parentItems.find(item => item.body.kind === 'tool' && item.body.toolCallId === run.parentToolCallId);
    const text = call?.body.kind === 'tool' ? callPrompt(call.body.input) : undefined;

    if (!text) return undefined;

    return {
        id: `${run.id}-prompt`,
        runId: run.id,
        seq: 0,
        at: run.startedAt ?? run.createdAt,
        body: { kind: 'user', text, from: { kind: 'thread', chatId: chat.id, title: chat.title } },
    };
}
