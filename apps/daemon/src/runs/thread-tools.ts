import { z } from 'zod';

import { MAX_WAIT_SECONDS, WAIT_SECONDS } from './threads';
import { defineTool, taskRef } from './tool-kit';

import type { Run } from '@clowdy/protocol';
import type { ToolDefinition } from '../engine/types';
import type { ToolDeps } from './tool-kit';

/** `thread_log` shows this many lines unless asked for another number, and never more than `MAX_LOG_LINES`. */
const LOG_LINES = 20;
const MAX_LOG_LINES = 100;

const thread = z.string().min(1).describe('The threadId (a chat id such as cht_...) that thread_spawn or thread_list gave');

const STATES = 'state is one word: working, asking (waits for the person\'s answer), idle (its turn is over; open lists background work it still has running), failed, stopped, interrupted (a restart cut it off) or new.';

/** What the daemon does when a thread stops, as the tools that start and read threads tell it. */
const NOTICES = 'Each time a thread of yours stops (its turn ends with an answer, it fails, or a restart interrupts it) the daemon sends you a message with its final answer, which starts a turn of yours when you are at rest; a thread that still has background work running says so and reports again when that work is done.';

/**
 * The thread tools of a chat's orchestrator. A thread is a chat below the caller's with an agent of its own; the caller starts it, messages it, stops it
 * and reads it here. Each tool is also a shell command for the agent (`ToolDefinition.cli`), so the inputs are flat.
 */
export function threadTools({ threads }: ToolDeps, run: Run): ToolDefinition[] {
    return [
        defineTool('thread_spawn', `Starts a thread: a new chat below yours with an agent of its own, which works on the prompt while you go on with yours. Use it for a separate piece of work that can run alongside (an investigation, a task, a check); do small things yourself. The thread does not see your conversation, so the prompt must carry everything it needs: the goal, what it may change, decisions already made, how to check the result, and what to report. It runs on your agent, model and mode unless you name others. Returns at once with its threadId, title and state. ${ NOTICES } So do not poll it or check on it in a loop: go on with other work, or end your turn. ${ STATES }`, z.object({
            prompt: z.string().min(1).describe('The assignment, complete: the thread knows nothing else'),
            title: z.string().optional().describe('A short name for the thread; default the first words of the prompt'),
            engine: z.string().optional().describe('The id of an installed agent (claude, codex, cursor, ...); default yours. Leave unset unless the person asked or you have a reason'),
            model: z.string().optional().describe('The model, in the agent\'s own spelling; default yours when the agent is yours'),
            effort: z.string().optional().describe('The reasoning level, in the agent\'s own spelling'),
            mode: z.enum(['autopilot', 'semi']).optional().describe('autopilot decides alone; semi asks the person at significant forks. Default your mode'),
            tasks: z.array(taskRef).optional().describe('Tasks the thread works on: it is assigned to them, and waits while their dependencies are not Done'),
            cwd: z.string().optional().describe('Absolute path of an existing folder the thread works in (a git worktree you made, say); default the project\'s main folder'),
        }), input => ({
            ...threads.spawn(run, input),
            note: 'The daemon sends you a message each time this thread stops, with its final answer, and starts a turn of yours for it when you are at rest. Do not poll it or wait for it in a loop: go on with your own work, or end your turn if you have none.',
        }), { cli: {} }),

        defineTool('thread_tell', 'Sends a message to another chat of your thread tree: a thread you started, a thread of theirs, your parent or a sibling. A chat at rest starts a turn on it. A busy one takes it into its running turn when its agent can (mode steer, the default), or as its next turn (mode queue, or when its agent cannot take it now). The receiver sees who sent it. Use it to give a thread new instructions or facts it needs. Do not send acknowledgements or thanks, and do not ask a thread for its result: its final answer reaches its parent when it stops. Returns delivery: started (a turn began on it) or queued (the thread was busy; do not send it again).', z.object({
            thread,
            message: z.string().min(1).describe('What to tell it'),
            mode: z.enum(['steer', 'queue']).optional().describe('steer (default) joins a running turn when the agent can; queue waits for the next turn'),
        }), input => threads.tell(run, input), { cli: { positional: ['thread', 'message'] } }),

        defineTool('thread_stop', 'Stops a thread below you as the person\'s Stop does: its running turn and the work it has open in the background end, and messages waiting for it are held. Threads below it are not stopped; stop each one you want stopped. Use it when the work is no longer needed or went wrong. The thread is not restarted by itself; a thread_tell starts it again. Returns stopped: false, with its state, when its work was over already.', z.object({
            thread,
        }), input => threads.stop(run, input.thread), { cli: { positional: ['thread'] } }),

        defineTool('thread_wait', `Waits until a thread below you stops working (its turn ends, it asks the person, fails or is stopped), or until the timeout, then answers like thread_output plus timedOut. A thread that is not working answers at once. While you wait you hold your slot and do nothing else, so prefer ending your turn: the daemon wakes you each time a thread stops. Use it only for a short wait when you have nothing else to do. When the thread is idle, failed or interrupted, what it answers replaces the message about that thread that has not reached you yet: you are not told it again. ${ STATES }`, z.object({
            thread,
            timeoutSeconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).optional().describe(`How long to wait at most, 1 to ${ MAX_WAIT_SECONDS } seconds; default ${ WAIT_SECONDS }`),
        }), (input, signal) => threads.wait(run, input, signal), { cli: { positional: ['thread'] } }),

        defineTool('thread_output', `Reads what a chat of your thread tree said in its latest turn (its final answer, cut at 4,000 characters), how it stands, what it still has open in the background (then its answer is not final yet), and for a failed one the error. It does not wait. Use it when you need an answer again, or one that never reached you. Reading one of your own threads while it is idle, failed or interrupted replaces the message about it that has not reached you yet. ${ STATES }`, z.object({
            thread,
        }), input => threads.output(run, input.thread), { cli: { positional: ['thread'] } }),

        defineTool('thread_log', `Shows the last lines of a chat of your thread tree, oldest first, one short line each with its number: who wrote each message (the person, or a thread), how the threads in a notice stopped, what the agent said, the tools it called and how they went. Use it to see what a thread is doing or why it failed, not for routine checks. Default ${ LOG_LINES } lines.`, z.object({
            thread,
            limit: z.number().int().min(1).max(MAX_LOG_LINES).optional().describe(`How many lines, 1 to ${ MAX_LOG_LINES }; default ${ LOG_LINES }`),
        }), input => threads.log(run, input.thread, input.limit ?? LOG_LINES), { cli: { positional: ['thread'] } }),

        defineTool('thread_list', `Lists your threads, the ones you started, or with all every thread below you (depth 1 is yours, 2 one of theirs). Each comes with its threadId, title, parent, state, agent and model, what it has open in the background, and when its chat last had a message. ${ STATES }`, z.object({
            all: z.boolean().optional().describe('Also the threads of your threads'),
        }), input => threads.list(run, input.all ?? false), { cli: {} }),
    ];
}
