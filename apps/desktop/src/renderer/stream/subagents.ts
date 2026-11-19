import { basename } from '@clowdy/lib';

import { COMPACT_TOOL } from './compaction';
import { describeTool, firstString, isRecord } from './toolView';

import type { Run, StreamItem, StreamItemBody } from '@clowdy/protocol';

/** The tools agents start their own sub-agents with: Claude's `Agent` (once `Task`), Codex's `spawnAgent`, and the common `spawn_subagent`. */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task', 'spawnAgent', 'spawn_subagent']);

/** Clowdy's own tool for a child run with its own process and session. */
export const RUN_SPAWN = 'run_spawn';

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

/** The agent type a sub-agent call asks for, from its input: Claude's `subagent_type` or `name`, Codex's and others' `agent_type`. */
export function subagentName(input: unknown): string | undefined {
    return firstString(input, ['name', 'subagent_type', 'agent_type', 'agentType']);
}

/** The card's title: a verb while the sub-agent works, `Ran Explore agent` once it is over. */
export function subagentTitle(label: string | undefined, live: boolean): string {
    if (!live) return label ? `Ran ${ label } agent` : 'Ran agent';

    if (!label) return 'Running agent';

    return LIVE_VERBS[label.toLowerCase()] ?? `Running ${ label }`;
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

    if (view.icon === 'terminal') return target ? `Running ${ target }` : 'Running a command';

    if (view.icon === 'tool') return `Using ${ view.verb }`;

    const verb = ACTIVITY_VERBS[view.verb] ?? view.verb;

    return target ? `${ verb } ${ target }` : view.verb;
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

/** The latest item of a stream that says what its agent is doing: notes and errors are about it, not by it. */
export function latestActivity(items: readonly StreamItem[]): string | undefined {
    for (let index = items.length - 1; index >= 0; index--) {
        const { body } = items[index];

        if (body.kind === 'tool' || body.kind === 'assistant' || body.kind === 'question' || body.kind === 'user') return activityOf(body);
    }

    return undefined;
}

/** The second line of a sub-agent card: what the agent does while it works, `Finished` after; nothing for a failed or stalled call, whose title says it. */
export function agentStatusLine({ live, failed, stalled, activity }: { live: boolean; failed: boolean; stalled?: boolean; activity?: string }): string | undefined {
    if (failed || stalled) return undefined;

    if (!live) return 'Finished';

    return activity ?? 'Starting…';
}

/**
 * The id of the run a `run_spawn` call started, from its output: the object the daemon's tool returned, or that object as JSON text, which is
 * how most agents hand a tool's result back, sometimes wrapped in a content block of their own.
 */
export function spawnedRunId(output: unknown): string | undefined {
    let value = output;

    if (typeof output === 'string') {
        try {
            value = JSON.parse(output);
        }
        catch {
            value = undefined;
        }
    }

    if (isRecord(value) && typeof value.runId === 'string' && value.runId !== '') return value.runId;

    // A wrapper the agent put around the text, or the text quoted inside another JSON string.
    const text = typeof output === 'string' ? output : JSON.stringify(output) ?? '';

    return /\\*"runId\\*"\s*:\s*\\*"([^"\\]+)/.exec(text)?.[1];
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
