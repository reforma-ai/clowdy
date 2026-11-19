import { z } from 'zod';

import { listItems, nextSeq } from '../db/items';
import { isDescendant, markChildrenDelivered } from '../db/runs';
import { resolveTask, updateTask } from '../domain/tasks';
import { childReport } from './reports';
import { appendNote, ownTask, refuseFinalStatus, requestedStatus } from './task-tools';
import { clip, defineTool, taskRef } from './tool-kit';

import type { Run, StreamItem } from '@clowdy/protocol';
import type { ToolDefinition } from '../engine/types';
import type { ToolDeps } from './tool-kit';

export const ASK_USER = 'ask_user';

/** `run_wait` never blocks longer than this: the orchestrator's session is alive and idle meanwhile. */
const MAX_WAIT_SECONDS = 60;
const RECENT_ITEMS = 8;

// The fake engine is for demos and tests: a model that picked it would report work nobody did.
const engine = z.string().min(1).refine(id => id !== 'fake', 'The fake engine is not available to agents');

/** A stream item as one short line, for `run_inspect`. */
function describeItem(item: StreamItem): string {
    const { body } = item;

    switch (body.kind) {
        case 'tool':
            return `tool ${ body.name } (${ body.state })${ body.error ? `: ${ clip(body.error, 200) }` : '' }`;
        case 'question':
            return `question: ${ clip(body.text, 200) }`;
        default:
            return `${ body.kind }: ${ clip(body.text, 300) }`;
    }
}

/** The tools only an orchestrator has: starting, watching and stopping child runs. */
export function orchestratorRunTools({ store, runs, driver }: ToolDeps, run: Run): ToolDefinition[] {
    const ownRun = (runId: string): Run => {
        if (!isDescendant(store.db, run.id, runId)) {
            throw new Error(`Run ${ runId } is not one of your child runs`);
        }

        return runs.require(runId);
    };

    return [
        defineTool('run_spawn', 'Starts a child run on one or more tasks and returns at once with its runId; it works in its own process and session. role "executor" does the work, "verifier" checks it independently (give it the claim and the acceptance criteria, never the executor\'s reasoning). A run on tasks whose dependencies are not Done yet waits (status blocked, reason "Waiting for <key>") and starts by itself. Always pass an idempotencyKey like "CLW-21-executor-1": repeating a call with the same key starts nothing new. Then end your turn: the daemon resumes you with each child\'s summary.', z.object({
            taskIds: z.array(taskRef).min(1).describe('The tasks the run works on or checks'),
            prompt: z.string().min(1).describe('The assignment: mode, goal, owned paths, contracts, decisions already made, done-when. The child does not see your conversation.'),
            role: z.enum(['executor', 'verifier']).optional().describe('Default executor'),
            engine: engine.optional().describe('The id of an installed agent (claude, codex, cursor, ...). Leave unset unless the manager asked or you have a reason'),
            model: z.string().optional(),
            cwd: z.string().optional().describe('Absolute path of the folder the run works in (for example a git worktree you made); default the main folder of the project'),
            idempotencyKey: z.string().min(1),
        }), (input) => {
            const { run: child, duplicate } = driver.spawn({
                parent: run,
                tasks: input.taskIds.map(reference => resolveTask(store, run.projectId, reference)),
                prompt: input.prompt,
                role: input.role ?? 'executor',
                idempotencyKey: input.idempotencyKey,
                engine: input.engine,
                model: input.model,
                cwd: input.cwd,
            });

            return { runId: child.id, name: child.name, role: child.role, status: child.status, statusReason: child.statusReason, duplicate };
        }),

        defineTool('run_inspect', 'Reads one of your child runs: state, summary, failure reason and the last lines of its stream. For diagnosis when a summary leaves a real question; not for routine reading and never for polling.', z.object({ runId: z.string() }), ({ runId }) => {
            const child = ownRun(runId);
            const recent = listItems(store.db, runId, Math.max(0, nextSeq(store.db, runId) - 1 - RECENT_ITEMS));

            return { ...childReport(store, child, 4000), status: child.status, statusReason: child.statusReason, usage: child.usage, startedAt: child.startedAt, finishedAt: child.finishedAt, recent: recent.map(describeItem) };
        }),

        defineTool('run_wait', `Waits up to ${ MAX_WAIT_SECONDS } seconds for the given child runs to finish and returns how each stands. A fallback for a short wait when you have nothing else to do and the next step needs a result now; otherwise end your turn and let the daemon resume you.`, z.object({
            runIds: z.array(z.string()).min(1),
            timeoutSeconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).optional().describe(`Default 30, at most ${ MAX_WAIT_SECONDS }`),
        }), async (input, signal) => {
            input.runIds.forEach(ownRun);

            const waited = await runs.waitForRuns(input.runIds, (input.timeoutSeconds ?? 30) * 1000, signal);
            const finished = waited.filter(child => !['queued', 'running', 'waiting_children', 'waiting_user', 'blocked'].includes(child.status));

            // The parent has read these results here, so it need not be told again when it is resumed.
            store.tx(() => markChildrenDelivered(store.db, run.id, finished.map(child => child.id)));

            return { runs: waited.map(child => childReport(store, child)), timedOut: finished.length < waited.length };
        }),

        defineTool('run_cancel', 'Stops one of your child runs and everything below it. Use it when the plan changed; the run is not restarted by itself.', z.object({
            runId: z.string(),
            reason: z.string().optional(),
        }), (input) => {
            ownRun(input.runId);

            return store.tx(() => {
                const cancelled = runs.cancel(input.runId, input.reason ? `Cancelled by the orchestrator: ${ input.reason }` : 'Cancelled by the orchestrator');

                // You did it yourself, so you need no message about it.
                markChildrenDelivered(store.db, run.id, cancelled);

                return { cancelled };
            });
        }),
    ];
}

/** Semi-manual orchestrators ask the user through a question card and wait for the answer. */
export function askUserTool({ runs }: ToolDeps, run: Run): ToolDefinition {
    return defineTool(ASK_USER, 'Asks the user one question and waits for the answer. Offer concrete options a manager can weigh, and mark the one you recommend. Only for significant forks; decide routine things yourself.', z.object({
        question: z.string().min(1),
        options: z.array(z.object({ id: z.string(), label: z.string(), consequence: z.string().optional() })).min(1),
        recommended: z.string().optional().describe('The id of the option you recommend'),
    }), async (input, signal) => {
        const answer = await runs.ask(run.id, { text: input.question, options: input.options, recommended: input.recommended }, signal);
        const option = input.options.find(candidate => candidate.id === answer);

        return { answer: option?.label ?? answer };
    });
}

/** Executors and verifiers end their work with this call. */
export function reportResultTool(deps: ToolDeps, run: Run): ToolDefinition {
    const { store, driver } = deps;

    return defineTool('report_result', 'Ends your work with a result: status done, failed or blocked and a summary with the verdict first (the orchestrator keeps about 2 KB). taskUpdates moves your tasks up to Review (never Done) and appends a note to each task\'s description. Call it once, last; your run is over when you do.', z.object({
        status: z.enum(['done', 'failed', 'blocked']),
        summary: z.string().min(1),
        taskUpdates: z.array(z.object({
            taskId: taskRef,
            statusId: z.string().optional().describe('A status id from task_list, or a status name or category such as "review"'),
            status: z.string().optional(),
            note: z.string().optional().describe('Appended to the task\'s Notes'),
        })).optional(),
    }), input => store.tx(() => {
        for (const update of input.taskUpdates ?? []) {
            const task = ownTask(deps, run, update.taskId);
            const status = requestedStatus(store, run.projectId, update);

            if (status) {
                refuseFinalStatus(status);
            }

            updateTask(store, task.id, { statusId: status?.id, description: update.note ? appendNote(task.description, run.role, update.note) : undefined });
        }

        driver.report(run.id, { status: input.status, summary: input.summary });

        return { ok: true, message: 'Your result is recorded. Your work is finished: end your turn now without further tool calls.' };
    }));
}
