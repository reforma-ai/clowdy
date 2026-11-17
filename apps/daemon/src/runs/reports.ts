import { getRunWork, linksOfRun } from '../db/runs';
import { getTask } from '../db/tasks';

import type { Run } from '@clowdy/protocol';
import type { Store } from '../store';

/** About what one child may take in a message to its parent. */
const CHILD_CHARS = 2000;
/** What one message may take in all; children beyond it are named, not described. */
const TOTAL_CHARS = 24_000;

/** A child as its parent sees it: what the skills call the state, plus a bounded summary. */
export interface ChildReport {
    runId: string;
    name: string;
    role: Run['role'];
    taskIds: string[];
    /** `succeeded`, `failed`, `blocked` (the run reported a blocker), `cancelled`, `interrupted`, or the status of a run still active. */
    state: string;
    summary?: string;
    reason?: string;
}

const clip = (text: string, limit: number) => (text.length > limit ? `${ text.slice(0, limit - 1) }…` : text);

/** Keys of the tasks a run is linked to, as the orchestrator knows them. */
export function taskKeysOf(store: Store, runId: string): string[] {
    const keys = linksOfRun(store.db, runId).map(link => getTask(store.db, link.taskId)?.key ?? link.taskId);

    return [...new Set(keys)];
}

export function childReport(store: Store, run: Run, limit = CHILD_CHARS): ChildReport {
    const blocked = run.status === 'failed' && getRunWork(store.db, run.id).outcome === 'blocked';
    const reason = run.status === 'failed' ? run.error : ['cancelled', 'interrupted'].includes(run.status) ? run.statusReason : undefined;

    return {
        runId: run.id,
        name: run.name,
        role: run.role,
        taskIds: taskKeysOf(store, run.id),
        state: blocked ? 'blocked' : run.status,
        ...(run.result && { summary: clip(run.result, limit) }),
        ...(reason && { reason: clip(reason, limit) }),
    };
}

/** The message that wakes a parent: one block per finished child, each bounded, the whole bounded too. */
export function wakeMessage(store: Store, children: Run[]): string {
    const blocks: string[] = [];
    let size = 0;
    let shown = 0;

    for (const [index, run] of children.entries()) {
        const report = childReport(store, run);
        const lines = [
            `${ index + 1 }. ${ report.name } (${ report.runId })${ report.taskIds.length > 0 ? ` on ${ report.taskIds.join(', ') }` : '' }: ${ report.state }`,
            report.reason && `Reason: ${ report.reason }`,
            report.state === 'cancelled' && 'Someone stopped this run on purpose. Do not restart it silently: hold the work that depends on it and say so in your report.',
            report.state === 'interrupted' && 'The process died or the app restarted. Check what it changed before spawning one continuation.',
            report.summary && `Summary: ${ report.summary }`,
        ].filter(Boolean).join('\n');

        if (size + lines.length > TOTAL_CHARS) {
            break;
        }

        blocks.push(lines);
        size += lines.length;
        shown++;
    }

    const omitted = children.slice(shown).map(run => `${ run.name } (${ run.id })`);

    return [
        `${ children.length === 1 ? 'A child run has' : `${ children.length } child runs have` } finished. Handle every one before you start new work (see "Handling child results" in clowdy:orchestrate).`,
        ...blocks,
        omitted.length > 0 && `Not shown here, use run_inspect: ${ omitted.join(', ') }.`,
    ].filter(Boolean).join('\n\n');
}
