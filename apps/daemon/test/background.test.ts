import { STOPPED_TOOL } from '@clowdy/protocol';
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';

import { getChat } from '../src/db/chats';
import { listItems } from '../src/db/items';
import { getRunWork, pendingMailbox, runningCounts } from '../src/db/runs';
import { projectSnapshot } from '../src/domain/snapshots';
import { cleanTempDirs, latch, restartHarness, ScriptEngine, scriptEngines, startHarness, waitFor } from './helpers';

import type { BackgroundItem, Chat, ChatMode, Run, RunStatus } from '@clowdy/protocol';
import type { EngineEvent } from '../src/engine/types';
import type { Harness, Script, Turn } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];
const spawned: number[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));

    for (const pid of spawned.splice(0)) {
        try {
            process.kill(-pid, 'SIGKILL');
        }
        catch {
            // already gone
        }
    }
});

type Latch = ReturnType<typeof latch>;

/** A process in a group of its own, like an engine's process, that the test kills when it ends. */
function startProcess(command: string): number {
    const child = spawn('sh', ['-c', command], { detached: true, stdio: 'ignore' });

    child.unref();
    spawned.push(child.pid!);

    return child.pid!;
}

const command: BackgroundItem = { id: 'bg-1', kind: 'command', title: 'sleep 60' };

interface Plan {
    /** What the first turn starts in the background. */
    items?: BackgroundItem[];
    /** The engine process the session reports. */
    pid?: number;
    /** Released by the test when the work ends: the agent says so in a turn of its own, and the session ends. */
    finished: Latch;
    /** What the agent says in that turn. */
    report?: (turn: Turn) => AsyncGenerator<EngineEvent>;
    /** Held before the `done` of each answer to a message sent into the session, in order. */
    gates?: Latch[];
}

async function* finishedLine(): AsyncGenerator<EngineEvent> {
    yield { type: 'background', items: [] };
    yield { type: 'text', delta: 'The command finished', done: true };
    yield { type: 'done', result: 'The command finished' };
}

/**
 * A chat orchestrator whose first turn starts background work and ends, then keeps its session: it answers each message sent into it (one `done` each)
 * and, once the test releases `finished`, reports in a turn of its own and ends the session. Every later session of the run only says it is back.
 */
function lingering(plan: Plan): Script {
    return async function* (turn) {
        yield { type: 'session', sessionId: 's-1' };

        if (turn.number > 1) {
            yield { type: 'text', delta: 'Back again', done: true };
            yield { type: 'done', result: 'Back again' };

            return;
        }

        if (plan.pid) {
            yield { type: 'process', pid: plan.pid, pgid: plan.pid };
        }

        yield { type: 'text', delta: 'Started it', done: true };
        yield { type: 'background', items: plan.items ?? [command] };
        yield { type: 'done', result: 'Started it' };

        // One receiver at a time: a second one would take a message the first is waiting for.
        let message = turn.received();
        const finished = turn.hold(plan.finished);

        for (;;) {
            const next = await Promise.race([message.then(text => ({ text })), finished.then(released => ({ released }))]);

            if ('text' in next) {
                if (next.text === undefined) {
                    return;
                }

                yield { type: 'text', delta: `Heard: ${ next.text }`, done: true };
                await plan.gates?.shift()?.wait(turn.signal);
                yield { type: 'done', result: `Heard: ${ next.text }` };
                message = turn.received();
            }
            else {
                if (next.released) {
                    yield* (plan.report ?? finishedLine)(turn);
                }

                return;
            }
        }
    };
}

async function setup(script: Script, overrides: Parameters<typeof startHarness>[0] = {}, answers: ScriptEngine['sendAnswer'] | false = () => true, mode?: ChatMode) {
    const engine = new ScriptEngine(script);

    if (answers) {
        engine.sendAnswer = answers;
    }

    const h = await startHarness(overrides, { engines: scriptEngines(engine) });

    harnesses.push(h);

    const project = h.openRepo();
    const { chat } = h.ok('chat.create', { projectId: project.id, ...(mode && { mode }) }) as { chat: Chat };
    const send = (text: string, chatId = chat.id) => h.ok('chat.send', { chatId, text }) as { chatId: string; runId: string };
    const runId = send('Do the work').runId;
    const bodies = (id = runId) => listItems(h.store.db, id, 0).map(item => item.body);
    const notes = (id = runId) => bodies(id).flatMap(body => (body.kind === 'note' ? [body.text] : []));
    const said = (id = runId) => bodies(id).flatMap(body => (body.kind === 'user' ? [body.text] : []));
    const status = (id = runId) => h.run(id).status;
    const waits = (id = runId) => waitFor(() => status(id) === 'waiting_background', 'the run to wait for background work');
    /** The statuses a run went through, from the event log. */
    const history = (id = runId): RunStatus[] => {
        const seen: RunStatus[] = [];

        for (const event of h.events()) {
            if (event.data.type === 'run.upserted' && event.data.run.id === id && seen.at(-1) !== event.data.run.status) {
                seen.push(event.data.run.status);
            }
        }

        return seen;
    };

    return { h, engine, project, chat, send, runId, bodies, notes, said, status, waits, history };
}

describe('a run that waits for background work', () => {
    test('holds no slot and counts for no process while it waits, keeps its process recorded, and ends with its session', async () => {
        const finished = latch();
        const pid = startProcess('sleep 60');
        const { h, engine, project, runId, waits, status } = await setup(lingering({ finished, pid }), { maxRuns: 1, maxProcesses: 1 });

        await waits();

        expect(h.run(runId)).toMatchObject({ statusReason: 'Waiting for background work', background: [command] });
        expect(h.run(runId).finishedAt).toBeUndefined();
        expect(runningCounts(h.store.db)).toEqual([]);
        expect(getRunWork(h.store.db, runId).process).toMatchObject({ pid, pgid: pid });
        expect(engine.closed).toBe(0);

        // The only slot and the only process the daemon allows are free for another chat, which runs and ends meanwhile.
        const other = h.ok('chat.create', { projectId: project.id }).chat as Chat;
        const otherRunId = h.ok('chat.send', { chatId: other.id, text: 'Another chat' }).runId as string;

        await waitFor(() => status(otherRunId) === 'succeeded', 'the other chat to finish');
        expect(status(runId)).toBe('waiting_background');
        expect(engine.turns).toHaveLength(2);

        finished.release();
        await waitFor(() => status(runId) === 'succeeded', 'the run to end with its session');

        expect(h.run(runId)).toMatchObject({ result: 'The command finished' });
        expect(h.run(runId).background).toBeUndefined();
        expect(h.run(runId).statusReason).toBeUndefined();
        await waitFor(() => engine.closed === 2 && !getRunWork(h.store.db, runId).process, 'the session to be closed and its process forgotten');
    });

    test('writes what the agent starts by itself as a message of its own with its tools, usage and context, and takes no slot for it', async () => {
        const finished = latch();
        const midTurn = latch();
        const { h, runId, bodies, notes, waits, status } = await setup(async function* (turn) {
            yield { type: 'session', sessionId: 's-1' };
            yield { type: 'text', delta: 'Started it', done: true };
            yield { type: 'background', items: [command] };
            yield { type: 'done', result: 'Started it' };

            if (!await turn.hold(finished)) {
                return;
            }

            yield { type: 'background', items: [] };
            yield { type: 'tool', toolCallId: 'report-1', name: 'Read', input: { path: 'out.log' }, state: 'running' };
            yield { type: 'tool', toolCallId: 'report-1', name: 'Read', input: { path: 'out.log' }, state: 'done', output: 'ok' };
            yield { type: 'text', delta: 'The command ', done: false };

            if (!await turn.hold(midTurn)) {
                return;
            }

            yield { type: 'text', delta: 'finished', done: true };
            yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
            yield { type: 'context', used: 50_000, size: 200_000 };
            yield { type: 'done', result: 'The command finished' };
        });

        await waits();
        finished.release();
        await waitFor(() => bodies().some(body => body.kind === 'tool'), 'the turn the agent started');

        // It is working, and still takes no slot: the status is the one it waited in.
        expect(status()).toBe('waiting_background');
        expect(runningCounts(h.store.db)).toEqual([]);
        expect(h.run(runId).background).toBeUndefined();

        midTurn.release();
        await waitFor(() => status() === 'succeeded', 'the run to end');

        expect(bodies().map(body => body.kind)).toEqual(['user', 'assistant', 'note', 'tool', 'assistant']);
        expect(bodies()[1]).toMatchObject({ text: 'Started it', done: true });
        expect(bodies()[3]).toMatchObject({ kind: 'tool', toolCallId: 'report-1', name: 'Read', state: 'done', output: 'ok' });
        expect(bodies()[4]).toMatchObject({ text: 'The command finished', done: true });
        expect(notes()).toEqual(['Background command finished: sleep 60']);
        expect(h.run(runId).usage).toEqual({ inputTokens: 10, outputTokens: 5 });
        expect(h.run(runId).context).toEqual({ used: 50_000, size: 200_000 });
    });

    test('keeps a workflow call that is a background task running while the run waits, and fails the calls left open that are not', async () => {
        const finished = latch();
        const workflow: BackgroundItem = { id: 'wf-1', kind: 'task', title: 'Workflow' };
        const { runId, bodies, waits } = await setup(async function* (turn) {
            yield { type: 'session', sessionId: 's-1' };
            yield { type: 'tool', toolCallId: 'wf-1', name: 'Workflow', input: {}, state: 'running' };
            yield { type: 'tool', toolCallId: 'lost-1', name: 'Bash', input: {}, state: 'running' };
            yield { type: 'text', delta: 'Started it', done: true };
            yield { type: 'background', items: [workflow] };
            yield { type: 'done', result: 'Started it' };

            if (!await turn.hold(finished)) {
                return;
            }

            yield { type: 'tool', toolCallId: 'wf-1', name: 'Workflow', input: {}, state: 'done', output: 'ok' };
            yield { type: 'background', items: [] };
            yield { type: 'text', delta: 'The workflow finished', done: true };
            yield { type: 'done', result: 'The workflow finished' };
        });

        await waits();

        const tools = () => bodies().flatMap(body => (body.kind === 'tool' ? [body] : []));

        expect(tools().find(tool => tool.toolCallId === 'wf-1')).toMatchObject({ state: 'running' });
        expect(tools().find(tool => tool.toolCallId === 'lost-1')).toMatchObject({ state: 'error' });

        finished.release();
        await waitFor(() => tools().find(tool => tool.toolCallId === 'wf-1')?.state === 'done', 'the workflow call to finish');
    });

    test('refuses a question in a turn the agent starts by itself in words a person can read, with no card and no status of its own', async () => {
        const finished = latch();
        const refusals: string[] = [];
        const { status, waits, bodies, history } = await setup(lingering({
            finished,
            report: async function* (turn) {
                try {
                    yield* turn.call('ask_user', { question: 'Which one?', options: [{ id: 'a', label: 'A' }] });
                }
                catch (error) {
                    refusals.push((error as Error).message);
                }

                yield* finishedLine();
            },
        }), {}, () => true, 'semi');

        await waits();
        finished.release();
        await waitFor(() => status() === 'succeeded', 'the run to end after its report');

        expect(refusals).toEqual(['Can\'t ask a question while the run waits for background work or child runs']);
        expect(bodies().some(body => body.kind === 'question')).toBe(false);
        expect(history()).not.toContain('waiting_user');
    });

    test('ends when its engine cannot take a prompt after a turn, as every session did before: at the first done', async () => {
        const { h, runId, status } = await setup(async function* () {
            yield { type: 'session', sessionId: 's-1' };
            yield { type: 'background', items: [command] };
            yield { type: 'done', result: 'Started it' };
        }, {}, false);

        await waitFor(() => status() === 'succeeded', 'the run to end at its first done');
        expect(h.run(runId).background).toBeUndefined();
    });

    test('is ended at the first done for every role but a chat\'s orchestrator: a spawned executor does not wait', async () => {
        const { h, runId, status } = await setup(async function* (turn) {
            yield { type: 'session', sessionId: `s-${ turn.number }` };

            if (turn.options.tools.some(tool => tool.name === 'run_spawn') && !turn.options.resumeSessionId) {
                const { task } = yield* turn.call('task_create', { title: 'Task 1' });

                yield* turn.call('run_spawn', { taskIds: [task.key], prompt: `Goal: ${ task.key }`, idempotencyKey: 'executor-1' });
            }
            else if (!turn.options.tools.some(tool => tool.name === 'run_spawn')) {
                yield { type: 'background', items: [command] };
            }

            yield { type: 'done', result: 'ok' };
        });

        await waitFor(() => status() === 'succeeded', 'the orchestrator to finish after its executor');

        const [child] = projectSnapshot(h.store, h.run(runId).projectId).runs.filter(run => run.origin === 'spawned');

        expect(child).toMatchObject({ role: 'executor', status: 'succeeded' });
        expect(child.background).toBeUndefined();
        expect(h.run(runId).background).toBeUndefined();
    });
});

describe('the notes of finished background work', () => {
    test('says in the stream which item left the snapshot, kind by kind, with its title cut at about 80 characters', async () => {
        const long = `npm run build ${ 'x'.repeat(120) }`;
        const items: BackgroundItem[] = [command, { id: 'bg-2', kind: 'subagent', title: 'Researcher' }, { id: 'bg-3', kind: 'task', title: long }];
        const { notes, status } = await setup(async function* () {
            yield { type: 'session', sessionId: 's-1' };
            yield { type: 'background', items };
            yield { type: 'done', result: 'Started them' };
            yield { type: 'background', items: items.slice(1) };
            yield { type: 'background', items: items.slice(1) };
            yield { type: 'background', items: [items[2], items[1]] };
            yield { type: 'background', items: [items[2]] };
            yield { type: 'background', items: [] };
            yield { type: 'text', delta: 'All of it finished', done: true };
            yield { type: 'done', result: 'All of it finished' };
        });

        await waitFor(() => status() === 'succeeded', 'the run to end');
        expect(notes()).toEqual([
            'Background command finished: sleep 60',
            'Background sub-agent finished: Researcher',
            `Background task finished: ${ long.slice(0, 79) }…`,
        ]);
    });
});

describe('a message to a run that waits', () => {
    test('goes into the live session through the queue and a slot, is answered there, and the run waits again', async () => {
        const finished = latch();
        const gate = latch();
        const { h, engine, runId, send, said, bodies, waits, status } = await setup(lingering({ finished, gates: [gate] }));

        await waits();
        send('How is it going');

        // It takes the run back through the scheduler: a slot is held while the agent answers, and no second session starts.
        await waitFor(() => status() === 'running' && engine.sent.length === 1, 'the run to take a slot and the message to reach the session');
        expect(engine.sent).toEqual(['How is it going']);
        expect(engine.turns).toHaveLength(1);
        expect(runningCounts(h.store.db)).toEqual([{ engine: 'fake', projectId: h.run(runId).projectId, count: 1 }]);
        expect(h.run(runId).background).toEqual([command]);

        gate.release();
        await waitFor(() => engine.sent.length === 1 && status() === 'waiting_background', 'the run to wait again after its answer');
        expect(runningCounts(h.store.db)).toEqual([]);
        expect(h.run(runId)).toMatchObject({ statusReason: 'Waiting for background work', background: [command] });

        // A second message goes the same way, to the same session.
        send('And now');
        await waitFor(() => engine.sent.length === 2, 'the second message');
        await waitFor(() => bodies().some(body => body.kind === 'assistant' && body.text === 'Heard: And now'), 'the second answer');
        await waitFor(() => status() === 'waiting_background', 'the run to wait again');

        expect(engine.sent).toEqual(['How is it going', 'And now']);
        expect(engine.turns).toHaveLength(1);
        expect(said()).toEqual(['Do the work', 'How is it going', 'And now']);
        expect(bodies().map(body => body.kind)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
        expect(getRunWork(h.store.db, runId).nextPrompt).toBeUndefined();
        expect(engine.closed).toBe(0);
    });

    test('that the chat held back while the turn ran is delivered to the live session when the turn ends, not to a second one', async () => {
        const gate = latch();
        const finished = latch();
        const { h, engine, chat, runId, send, said, bodies, waits } = await setup(async function* (turn) {
            yield { type: 'session', sessionId: 's-1' };
            yield { type: 'text', delta: 'Working', done: false };
            await gate.wait(turn.signal);
            yield { type: 'text', delta: ' on it', done: true };
            yield { type: 'background', items: [command] };
            yield { type: 'done', result: 'Started it' };

            const text = await turn.received();

            yield { type: 'text', delta: `Heard: ${ text }`, done: true };
            yield { type: 'done', result: 'Heard' };
            await turn.hold(finished);
        });

        await waitFor(() => engine.turns.length === 1, 'the first turn');
        send('Also the footer');
        expect(getChat(h.store.db, chat.id)?.queue?.map(item => item.text)).toEqual(['Also the footer']);

        gate.release();
        await waitFor(() => engine.sent.length === 1, 'the queued message to be handed to the session');
        await waitFor(() => bodies().some(body => body.kind === 'assistant' && body.text === 'Heard: Also the footer'), 'its answer');
        await waits();

        expect(engine.sent).toEqual(['Also the footer']);
        expect(engine.turns).toHaveLength(1);
        expect(getChat(h.store.db, chat.id)?.queue ?? []).toEqual([]);
        expect(said(runId)).toEqual(['Do the work', 'Also the footer']);
    });

    test('that arrives during a turn the agent started joins it, and one done ends both', async () => {
        const finished = latch();
        const joined = latch();
        const { h, engine, runId, send, bodies, waits, status, history } = await setup(async function* (turn) {
            yield { type: 'session', sessionId: 's-1' };
            yield { type: 'background', items: [command, { id: 'bg-2', kind: 'task', title: 'Build' }] };
            yield { type: 'done', result: 'Started them' };

            if (!await turn.hold(finished)) {
                return;
            }

            // The agent's own turn: the first command is over, the build still runs.
            yield { type: 'background', items: [{ id: 'bg-2', kind: 'task', title: 'Build' }] };
            yield { type: 'text', delta: 'The command finished. ', done: false };
            joined.release();

            const text = await turn.received();

            // The prompt joins the turn, which holds back its done until the prompt is answered.
            yield { type: 'text', delta: `And about "${ text }": ready`, done: true };
            yield { type: 'done', result: 'Both answered' };
            await turn.hold(latch());
        });

        await waits();
        finished.release();
        await joined.wait();
        await waitFor(() => bodies().some(body => body.kind === 'assistant' && body.text.startsWith('The command finished')), 'the turn of the agent');
        expect(status()).toBe('waiting_background');

        send('Is the build done');
        await waitFor(() => bodies().some(body => body.kind === 'assistant' && body.text.endsWith('ready')), 'the answer');
        await waitFor(() => status() === 'waiting_background' && engine.sent.length === 1, 'the run to wait again, for the build');

        expect(engine.sent).toEqual(['Is the build done']);
        expect(engine.turns).toHaveLength(1);
        expect(h.run(runId).background).toEqual([{ id: 'bg-2', kind: 'task', title: 'Build' }]);
        // The message took a slot and gave it back; the agent's turn took none.
        expect(history()).toEqual(['queued', 'running', 'waiting_background', 'queued', 'running', 'waiting_background']);
    });

    test('that the session refuses becomes the next turn of a new session that resumes the conversation, told what was lost with the old one', async () => {
        const finished = latch();
        const { h, engine, runId, send, waits, status, history } = await setup(lingering({ finished }), {}, () => false);

        await waits();
        send('Are you there');

        await waitFor(() => status() === 'succeeded' && engine.turns.length === 2, 'the message to run in a new session');

        const [first, second] = engine.turns;

        expect(engine.sent).toEqual(['Are you there']);
        expect(second).toMatchObject({ resumeSessionId: 's-1' });
        expect(second.prompt.startsWith('Are you there')).toBe(true);
        expect(second.prompt).toContain('lost');
        expect(second.prompt).toContain('- command: sleep 60');
        expect(first.resumeSessionId).toBeUndefined();
        // The first session was closed before the second started, and the record of what was lost is cleared once it is told.
        expect(engine.closed).toBe(2);
        expect(engine.closedAt[0]).toBeLessThanOrEqual(engine.startedAt[1]);
        expect(getRunWork(h.store.db, runId).nextPrompt).toBeUndefined();
        expect(getRunWork(h.store.db, runId).lostBackground).toBeUndefined();
        expect(h.run(runId).background).toBeUndefined();
        expect(h.run(runId).result).toBe('Back again');
        // It went through the scheduler once, and the slot it took for the message served the new session.
        expect(history()).toEqual(['queued', 'running', 'waiting_background', 'queued', 'running', 'succeeded']);
    });
});

describe('messages that follow each other into a session that waits', () => {
    test('two messages in quick succession reach the session one after the other, each answered once', async () => {
        const finished = latch();
        const gate = latch();
        const { engine, send, said, waits, status } = await setup(lingering({ finished, gates: [gate] }));

        await waits();
        send('First');
        send('Second');

        // The second waits in the chat's queue while the first is answered, then goes the same way.
        await waitFor(() => engine.sent.length === 1, 'the first message to reach the session');
        expect(engine.sent).toEqual(['First']);
        expect(status()).toBe('running');

        gate.release();
        await waitFor(() => engine.sent.length === 2 && status() === 'waiting_background' && said().length === 3, 'the second message to be answered');
        expect(engine.sent).toEqual(['First', 'Second']);
        expect(said()).toEqual(['Do the work', 'First', 'Second']);
        expect(engine.turns).toHaveLength(1);
    });

    test('a message the session fails to take, by throwing, is refused like one it declines', async () => {
        const finished = latch();
        const { engine, send, waits, status } = await setup(lingering({ finished }), {}, () => {
            throw new Error('The pipe is closed');
        });

        await waits();
        send('Are you there');
        await waitFor(() => status() === 'succeeded' && engine.turns.length === 2, 'the message to run in a new session');
        expect(engine.turns[1].prompt.startsWith('Are you there')).toBe(true);
        expect(engine.turns[1].prompt).toContain('- command: sleep 60');
    });

    test('a message that waits for a slot when the agent ends its session becomes the next turn of a new one, and the old session is never asked', async () => {
        const finished = latch();
        const hold = latch();
        const { engine, project, h, bodies, send, said, waits, status } = await setup(async function* (turn) {
            if (turn.options.prompt.includes('Hold the slot')) {
                yield { type: 'session', sessionId: 's-hold' };
                await hold.wait(turn.signal);
                yield { type: 'done', result: 'Released' };

                return;
            }

            yield* lingering({ finished })(turn);
        }, { maxRuns: 1 });

        await waits();

        const other = h.ok('chat.create', { projectId: project.id }).chat as Chat;
        const otherRunId = h.ok('chat.send', { chatId: other.id, text: 'Hold the slot' }).runId as string;

        await waitFor(() => status(otherRunId) === 'running', 'the other chat to take the only slot');
        send('Anyone there');
        await waitFor(() => status() === 'queued', 'the message to wait for a slot');

        // The command finishes and the agent reports in a turn of its own, which needs no slot; its session then ends while the message still waits.
        finished.release();
        await waitFor(() => bodies().some(body => body.kind === 'assistant' && body.text === 'The command finished'), 'the report of the agent');
        expect(status()).toBe('queued');

        hold.release();
        await waitFor(() => status() === 'succeeded' && engine.turns.length === 3, 'the message to run in a new session');
        expect(engine.sent).toEqual([]);
        expect(engine.turns[2]).toMatchObject({ resumeSessionId: 's-1' });
        expect(engine.turns[2].prompt).toBe('Anyone there');
        expect(said()).toEqual(['Do the work', 'Anyone there']);
    });
});

describe('steering a run that waits', () => {
    test('a steer typed while the message ahead of it waits for a slot goes to the session after that message, never before it', async () => {
        const finished = latch();
        const hold = latch();
        const { h, engine, chat, project, runId, send, said, waits, status } = await setup(async function* (turn) {
            if (turn.options.prompt.includes('Hold the slot')) {
                yield { type: 'session', sessionId: 's-hold' };
                await hold.wait(turn.signal);
                yield { type: 'done', result: 'Released' };

                return;
            }

            yield* lingering({ finished })(turn);
        }, { maxRuns: 1 });

        await waits();

        const other = h.ok('chat.create', { projectId: project.id }).chat as Chat;
        const otherRunId = h.ok('chat.send', { chatId: other.id, text: 'Hold the slot' }).runId as string;

        await waitFor(() => status(otherRunId) === 'running', 'the other chat to take the only slot');
        send('First');
        await waitFor(() => status() === 'queued', 'the message to wait for a slot');
        h.ok('chat.send', { chatId: chat.id, text: 'Urgent', mode: 'steer' });

        // The steer is the agent's to take only once the session has the first message: nothing reaches it while that one waits.
        await Bun.sleep(40);
        expect(engine.steered).toEqual([]);
        expect(engine.sent).toEqual([]);

        hold.release();
        await waitFor(() => engine.sent.length === 2, 'both messages to reach the session');

        // The agent of this engine takes no steer, so the steer waited for the turn's end and went as a message of its own.
        expect(engine.sent).toEqual(['First', 'Urgent']);
        expect(engine.steered).toEqual(['Urgent']);
        expect(engine.turns.length).toBe(2);
        await waitFor(() => status() === 'waiting_background' && said().length === 3, 'the run to wait again');
        expect(said()).toEqual(['Do the work', 'First', 'Urgent']);
        expect(h.run(runId).background).toEqual([command]);
    });
});

describe('stopping a run that waits', () => {
    test('a cancel closes the session, forgets its process and leaves the run cancelled', async () => {
        const finished = latch();
        const pid = startProcess('sleep 60');
        const { h, engine, runId, waits, status, notes } = await setup(lingering({ finished, pid }));

        await waits();
        h.ok('run.cancel', { runId });

        expect(status()).toBe('cancelled');
        await waitFor(() => engine.closed === 1 && !getRunWork(h.store.db, runId).process, 'the session to be closed and its process forgotten');
        expect(h.run(runId).background).toBeUndefined();
        expect(h.run(runId).statusReason).toBe('Cancelled by user');
        await Bun.sleep(40);
        expect(status()).toBe('cancelled');
        expect(notes()).toEqual([]);
    });

    test('a cancel while its message waits for a slot ends it without the message ever reaching the agent', async () => {
        const finished = latch();
        const hold = latch();
        const { h, engine, project, runId, send, waits, status } = await setup(async function* (turn) {
            if (turn.options.prompt.includes('Hold the slot')) {
                yield { type: 'session', sessionId: 's-hold' };
                await hold.wait(turn.signal);
                yield { type: 'done', result: 'Released' };

                return;
            }

            yield* lingering({ finished })(turn);
        }, { maxRuns: 1 });

        await waits();

        const other = h.ok('chat.create', { projectId: project.id }).chat as Chat;
        const otherRunId = h.ok('chat.send', { chatId: other.id, text: 'Hold the slot' }).runId as string;

        await waitFor(() => status(otherRunId) === 'running', 'the other chat to take the only slot');
        send('Anyone there');
        await waitFor(() => status() === 'queued', 'the message to wait for a slot');
        expect(h.run(runId).statusReason).toBe('Waiting for a free slot');

        h.ok('run.cancel', { runId });
        await waitFor(() => engine.closed === 1, 'the session of the cancelled run to be closed');
        expect(status()).toBe('cancelled');
        expect(engine.sent).toEqual([]);

        hold.release();
        await waitFor(() => status(otherRunId) === 'succeeded', 'the other chat to finish');
        expect(status()).toBe('cancelled');
    });

    test('a daemon stop closes the session and leaves the status for the next start, which interrupts the run and keeps what it lost for its next message', async () => {
        const finished = latch();
        const { h, engine, chat, runId, waits } = await setup(lingering({ finished }));

        await waits();
        await h.stop();
        expect(engine.closed).toBe(1);

        const second = await restartHarness(h, { engines: scriptEngines(engine) });

        harnesses.push(second);

        // Stopping settled nothing: the run was waiting when the daemon went, and the restart found it so.
        const seen = second.events().flatMap(event => (event.data.type === 'run.upserted' && event.data.run.id === runId ? [event.data.run.status] : []));

        expect(seen.at(-2)).toBe('waiting_background');
        expect(seen.at(-1)).toBe('interrupted');
        expect(seen).not.toContain('succeeded');
        expect(second.run(runId)).toMatchObject({ status: 'interrupted', statusReason: 'Daemon restarted' });
        expect(second.run(runId).background).toBeUndefined();
        expect(getRunWork(second.store.db, runId).lostBackground).toEqual([command]);

        // The next message tells the agent that the background work was lost, and the record is cleared once it has.
        second.ok('chat.send', { chatId: chat.id, text: 'Where did we stop' });
        await waitFor(() => engine.turns.length === 2, 'the next turn');

        const [, resumed] = engine.turns;

        expect(resumed.resumeSessionId).toBe('s-1');
        expect(resumed.prompt.startsWith('Where did we stop')).toBe(true);
        expect(resumed.prompt).toContain('lost');
        expect(resumed.prompt).toContain('- command: sleep 60');
        await waitFor(() => second.run(runId).status === 'succeeded', 'the new turn to end');
        expect(getRunWork(second.store.db, runId).lostBackground).toBeUndefined();
    });

    test('a passing failure of the engine in an answer retries in a new session that is told what the old one lost', async () => {
        const finished = latch();
        const { h, engine, runId, send, waits, status } = await setup(async function* (turn) {
            if (turn.number > 1) {
                yield { type: 'session', sessionId: 's-1' };
                yield { type: 'done', result: 'Back again' };

                return;
            }

            yield { type: 'session', sessionId: 's-1' };
            yield { type: 'background', items: [command] };
            yield { type: 'done', result: 'Started it' };
            await turn.received();
            yield { type: 'error', message: 'Overloaded', retryable: true };
            await turn.hold(finished);
        });

        await waits();
        send('Are you there');
        await waitFor(() => status() === 'succeeded' && engine.turns.length === 2, 'the run to continue in a new session');

        expect(engine.turns[1].resumeSessionId).toBe('s-1');
        expect(engine.turns[1].prompt).toContain('Continue where you left off');
        expect(engine.turns[1].prompt).toContain('- command: sleep 60');
        expect(h.run(runId).background).toBeUndefined();
        expect(getRunWork(h.store.db, runId).lostBackground).toBeUndefined();
    });

    test('a cancel while the agent answers a message ends the turn, closes the session once and gives its process back', async () => {
        const finished = latch();
        const gate = latch();
        const { h, engine, project, runId, send, waits, status } = await setup(lingering({ finished, gates: [gate] }), { maxProcesses: 1 });

        await waits();
        send('Are you there');
        await waitFor(() => status() === 'running' && engine.sent.length === 1, 'the agent to be answering');

        h.ok('run.cancel', { runId });
        await waitFor(() => engine.closed === 1, 'the session to be closed');
        await Bun.sleep(40);
        expect(engine.closed).toBe(1);
        expect(status()).toBe('cancelled');
        expect(getRunWork(h.store.db, runId).lostBackground).toEqual([command]);

        // The daemon allows one process: the cancelled run's session is not counted any more, so another chat starts.
        const other = h.ok('chat.create', { projectId: project.id }).chat as Chat;
        const otherRunId = h.ok('chat.send', { chatId: other.id, text: 'Another chat' }).runId as string;

        await waitFor(() => status(otherRunId) === 'succeeded', 'the other chat to run');
    });

    test('a daemon stop while the message waits for a slot leaves the message for the next start, which runs it in a new session and tells what was lost', async () => {
        const finished = latch();
        const hold = latch();
        const { h, engine, project, chat, runId, send, waits, status } = await setup(async function* (turn) {
            if (turn.options.prompt.includes('Hold the slot')) {
                yield { type: 'session', sessionId: 's-hold' };
                await hold.wait(turn.signal);
                yield { type: 'done', result: 'Released' };

                return;
            }

            yield* lingering({ finished })(turn);
        }, { maxRuns: 1 });

        await waits();

        const other = h.ok('chat.create', { projectId: project.id }).chat as Chat;
        const otherRunId = h.ok('chat.send', { chatId: other.id, text: 'Hold the slot' }).runId as string;

        await waitFor(() => status(otherRunId) === 'running', 'the other chat to take the only slot');
        send('Anyone there');
        await waitFor(() => status() === 'queued', 'the message to wait for a slot');
        await h.stop();
        expect(engine.sent).toEqual([]);

        const second = await restartHarness(h, { engines: scriptEngines(engine) }, { maxRuns: 1 });

        harnesses.push(second);
        await waitFor(() => second.run(runId).status === 'succeeded' && engine.turns.length === 3, 'the message to run in a new session');

        expect(engine.turns[2]).toMatchObject({ resumeSessionId: 's-1' });
        expect(engine.turns[2].prompt.startsWith('Anyone there')).toBe(true);
        expect(engine.turns[2].prompt).toContain('- command: sleep 60');
        expect(second.run(otherRunId).status).toBe('interrupted');
        expect(getChat(second.store.db, chat.id)?.queue ?? []).toEqual([]);
    });

    test('an engine that dies while the run waits fails it with the engine\'s message', async () => {
        const dies = latch();
        const { h, runId, waits, status } = await setup(async function* (turn) {
            yield { type: 'session', sessionId: 's-1' };
            yield { type: 'background', items: [command] };
            yield { type: 'done', result: 'Started it' };

            if (await turn.hold(dies)) {
                yield { type: 'error', message: 'The agent process exited', code: 'process_crashed' };
            }
        });

        await waits();
        dies.release();
        await waitFor(() => status() === 'failed', 'the run to fail');
        expect(h.run(runId)).toMatchObject({ error: 'The agent process exited', failureCode: 'process_crashed' });
        expect(h.run(runId).background).toBeUndefined();
        await waitFor(() => !getRunWork(h.store.db, runId).process, 'its process to be forgotten');
    });
});

describe('what a Stop and a failure leave behind for a run that waits', () => {
    test('a Stop ends the background work with the session, and the next message tells the agent it is lost', async () => {
        const finished = latch();
        const { h, engine, runId, send, waits, status } = await setup(lingering({ finished }));

        await waits();
        h.ok('run.cancel', { runId });
        await waitFor(() => engine.closed === 1 && getRunWork(h.store.db, runId).lostBackground, 'the session to be closed and what it lost to be kept');
        expect(getRunWork(h.store.db, runId).lostBackground).toEqual([command]);

        send('Where were we');
        await waitFor(() => status() === 'succeeded' && engine.turns.length === 2, 'the message to run in a new session');

        expect(engine.sent).toEqual([]);
        expect(engine.turns[1]).toMatchObject({ resumeSessionId: 's-1' });
        expect(engine.turns[1].prompt.startsWith('Where were we')).toBe(true);
        expect(engine.turns[1].prompt).toContain('lost');
        expect(engine.turns[1].prompt).toContain('- command: sleep 60');
        expect(getRunWork(h.store.db, runId).lostBackground).toBeUndefined();
    });

    test('a message sent right after a Stop, while the old session is still shutting down, becomes the next turn of a new session', async () => {
        const finished = latch();
        const { h, engine, runId, send, waits, status } = await setup(async function* (turn) {
            if (turn.number > 1) {
                yield { type: 'session', sessionId: 's-1' };
                yield { type: 'done', result: 'Back again' };

                return;
            }

            yield { type: 'session', sessionId: 's-1' };
            yield { type: 'background', items: [command] };
            yield { type: 'done', result: 'Started it' };
            await turn.hold(finished);
            // An agent takes a moment to die after a Stop.
            await Bun.sleep(150);
        });

        await waits();
        h.ok('run.cancel', { runId });
        send('Are you there');

        await waitFor(() => status() === 'succeeded' && engine.turns.length === 2, 'the message to run in a new session');
        expect(engine.sent).toEqual([]);
        expect(engine.turns[1].prompt.startsWith('Are you there')).toBe(true);
        expect(engine.turns[1].prompt).toContain('- command: sleep 60');
    });

    test('what the agent reports while a Stop is shutting its session down does not come back onto the stopped run', async () => {
        const finished = latch();
        const { h, runId, waits, status } = await setup(async function* (turn) {
            yield { type: 'session', sessionId: 's-1' };
            yield { type: 'background', items: [command] };
            yield { type: 'done', result: 'Started it' };
            await turn.hold(finished);
            await Bun.sleep(60);
            yield { type: 'background', items: [command] };
            await Bun.sleep(60);
        });

        await waits();
        h.ok('run.cancel', { runId });
        await waitFor(() => !getRunWork(h.store.db, runId).process, 'the session to be over');
        await Bun.sleep(150);
        expect(status()).toBe('cancelled');
        expect(h.run(runId).background).toBeUndefined();
    });

    test('a passing failure of the agent in a turn of its own continues the run in a new session instead of failing it', async () => {
        const fails = latch();
        const { h, engine, runId, waits, status, history } = await setup(async function* (turn) {
            yield { type: 'session', sessionId: 's-1' };

            if (turn.number > 1) {
                yield { type: 'done', result: 'Back again' };

                return;
            }

            yield { type: 'background', items: [command] };
            yield { type: 'done', result: 'Started it' };

            if (await turn.hold(fails)) {
                yield { type: 'error', message: 'Overloaded (529)', retryable: true };
            }
        });

        await waits();
        fails.release();
        await waitFor(() => status() === 'succeeded' && engine.turns.length === 2, 'the run to continue in a new session');

        expect(engine.turns[1]).toMatchObject({ resumeSessionId: 's-1' });
        expect(engine.turns[1].prompt).toContain('Continue where you left off');
        expect(engine.turns[1].prompt).toContain('- command: sleep 60');
        expect(history()).toEqual(['queued', 'running', 'waiting_background', 'blocked', 'queued', 'running', 'succeeded']);
        expect(h.run(runId).background).toBeUndefined();
    });

    test('a limit of the engine that the agent reports in the answer to a message stops that turn, and the run continues in a new session after the pause', async () => {
        const finished = latch();
        const { h, engine, runId, send, waits, status, history } = await setup(async function* (turn) {
            yield { type: 'session', sessionId: 's-1' };

            if (turn.number > 1) {
                yield { type: 'done', result: 'Back again' };

                return;
            }

            yield { type: 'background', items: [command] };
            yield { type: 'done', result: 'Started it' };
            await turn.received();
            yield { type: 'limit', status: 'rejected', resetsAt: Date.now() + 300 };
            await turn.hold(finished);
        });

        await waits();
        send('Are you there');

        await waitFor(() => status() === 'blocked', 'the run to wait for the end of the limit');
        expect(h.run(runId).statusReason).toContain('usage limit');
        expect(h.run(runId).background).toBeUndefined();
        await waitFor(() => engine.closed === 1, 'the session of the cut-off turn to be closed');

        await waitFor(() => status() === 'succeeded' && engine.turns.length === 2, 'the run to continue after the pause', 8000);
        expect(engine.turns[1]).toMatchObject({ resumeSessionId: 's-1' });
        expect(engine.turns[1].prompt).toContain('Continue where you left off');
        expect(engine.turns[1].prompt).toContain('- command: sleep 60');
        expect(history()).toEqual(['queued', 'running', 'waiting_background', 'queued', 'running', 'blocked', 'queued', 'running', 'succeeded']);
    });

    test('an iterator that throws when its session is closed after a refused message still ends in the next turn of a new session', async () => {
        const finished = latch();
        const { engine, send, waits, status } = await setup(async function* (turn) {
            yield { type: 'session', sessionId: 's-1' };

            if (turn.number > 1) {
                yield { type: 'done', result: 'Back again' };

                return;
            }

            yield { type: 'background', items: [command] };
            yield { type: 'done', result: 'Started it' };

            if (!await turn.hold(finished)) {
                throw new Error('The agent was killed');
            }
        }, {}, () => false);

        await waits();
        send('Are you there');

        await waitFor(() => status() === 'succeeded' && engine.turns.length === 2, 'the message to run in a new session');
        expect(engine.turns[1].prompt.startsWith('Are you there')).toBe(true);
        expect(engine.turns[1].prompt).toContain('- command: sleep 60');
    });
});

describe('background work that a session lost', () => {
    test('is told in the first message after it, and a compact command, which is a turn of its own, leaves the telling to the message after that', async () => {
        const engine = new ScriptEngine(async function* (turn) {
            yield { type: 'session', sessionId: 's-1' };

            if (turn.number === 1) {
                yield { type: 'background', items: [command] };
            }

            yield { type: 'done', result: 'ok' };
        });
        // Claude's script stands in for its program, which is not on this machine; the engine of the run has no `send`, so its session ends at the first done.
        const h = await startHarness({}, { engines: new Map([['fake', engine], ['claude', engine]]) });

        harnesses.push(h);

        const { chat } = h.ok('chat.create', { projectId: h.openRepo().id, engine: 'claude' }) as { chat: Chat };
        const runId = h.ok('chat.send', { chatId: chat.id, text: 'Do the work' }).runId as string;

        await waitFor(() => h.run(runId).status === 'succeeded', 'the first turn to end');
        expect(getRunWork(h.store.db, runId).lostBackground).toEqual([command]);
        expect(h.run(runId).background).toBeUndefined();

        h.ok('chat.compact', { chatId: chat.id });
        await waitFor(() => engine.turns.length === 2 && h.run(runId).status === 'succeeded', 'the compact turn to end');
        expect(engine.turns[1].prompt).toBe('/compact');
        expect(getRunWork(h.store.db, runId).lostBackground).toEqual([command]);

        h.ok('chat.send', { chatId: chat.id, text: 'Where were we' });
        await waitFor(() => engine.turns.length === 3 && h.run(runId).status === 'succeeded', 'the next turn to end');
        expect(engine.turns[2].prompt.startsWith('Where were we')).toBe(true);
        expect(engine.turns[2].prompt).toContain('- command: sleep 60');
        expect(getRunWork(h.store.db, runId).lostBackground).toBeUndefined();
    });

    test('is not mentioned when the session ended on its own with nothing open', async () => {
        const finished = latch();
        const { h, engine, runId, send, status } = await setup(lingering({ finished }));

        await waitFor(() => status() === 'waiting_background', 'the run to wait');
        finished.release();
        await waitFor(() => status() === 'succeeded', 'the run to end with its session');
        expect(getRunWork(h.store.db, runId).lostBackground).toBeUndefined();

        send('Anything new');
        await waitFor(() => engine.turns.length === 2 && status() === 'succeeded', 'the next turn');
        expect(engine.turns[1].prompt).toBe('Anything new');
    });
});

describe('a message that joins a turn the agent started', () => {
    test('is shown after the words the agent had said, and the rest of the answer follows the message', async () => {
        const finished = latch();
        const joined = latch();
        const { bodies, send, waits, status } = await setup(async function* (turn) {
            yield { type: 'session', sessionId: 's-1' };
            yield { type: 'background', items: [command, { id: 'bg-2', kind: 'task', title: 'Build' }] };
            yield { type: 'done', result: 'Started them' };

            if (!await turn.hold(finished)) {
                return;
            }

            yield { type: 'background', items: [{ id: 'bg-2', kind: 'task', title: 'Build' }] };
            yield { type: 'text', delta: 'The command finished. ', done: false };
            joined.release();

            const text = await turn.received();

            yield { type: 'text', delta: `About "${ text }": ready`, done: true };
            yield { type: 'done', result: 'Both answered' };
            await turn.hold(latch());
        });

        await waits();
        finished.release();
        await joined.wait();
        await waitFor(() => bodies().some(body => body.kind === 'assistant' && body.text.startsWith('The command finished')), 'the turn of the agent');
        send('Is the build done');
        await waitFor(() => bodies().some(body => body.kind === 'assistant' && body.text.endsWith('ready')), 'the answer');
        await waitFor(() => status() === 'waiting_background', 'the run to wait again');

        expect(bodies().flatMap(body => (body.kind === 'user' || body.kind === 'assistant' ? [`${ body.kind }: ${ body.text }`] : []))).toEqual([
            'user: Do the work',
            'assistant: The command finished. ',
            'user: Is the build done',
            'assistant: About "Is the build done": ready',
        ]);
    });
});

describe('an orchestrator with children and background work', () => {
    function orchestrating(options: { finished: Latch; child: Latch; pid?: number }): Script {
        const isOrchestrator = (turn: Turn) => turn.options.tools.some(tool => tool.name === 'run_spawn');

        return async function* (turn) {
            if (!isOrchestrator(turn)) {
                yield { type: 'session', sessionId: 's-child' };
                await options.child.wait(turn.signal);
                yield* turn.call('report_result', { status: 'done', summary: 'Result: the footer is fixed' });
                yield { type: 'done' };

                return;
            }

            if (turn.options.resumeSessionId) {
                yield { type: 'session', sessionId: 's-1' };
                yield { type: 'done', result: 'Resumed' };

                return;
            }

            yield { type: 'session', sessionId: 's-1' };

            if (options.pid) {
                yield { type: 'process', pid: options.pid, pgid: options.pid };
            }

            const { task } = yield* turn.call('task_create', { title: 'Task 1' });

            yield* turn.call('run_spawn', { taskIds: [task.key], prompt: `Goal: ${ task.key }`, idempotencyKey: 'executor-1' });
            yield { type: 'background', items: [command] };
            yield { type: 'done', result: 'Spawned' };

            let message = turn.received();
            const finished = turn.hold(options.finished);

            for (;;) {
                const next = await Promise.race([message.then(text => ({ text })), finished.then(released => ({ released }))]);

                if (!('text' in next)) {
                    return;
                }

                if (next.text === undefined) {
                    return;
                }

                yield { type: 'text', delta: 'Got the results', done: true };
                yield { type: 'done', result: 'Got the results' };
                message = turn.received();
            }
        };
    }

    test('shows waiting_children and keeps its session, and the wake-up reaches that session; the run then waits for the background work', async () => {
        const finished = latch();
        const child = latch();
        const pid = startProcess('sleep 60');
        const { h, engine, runId, notes, status } = await setup(orchestrating({ finished, child, pid }));

        await waitFor(() => status() === 'waiting_children', 'the orchestrator to wait for its child');

        // Children win the status, and the background work is still in the run, the session open and its process recorded.
        expect(h.run(runId)).toMatchObject({ statusReason: 'Waiting for 1 child run', background: [command] });
        expect(getRunWork(h.store.db, runId).process).toMatchObject({ pid });
        expect(runningCounts(h.store.db).reduce((sum, row) => sum + row.count, 0)).toBe(1);

        child.release();
        await waitFor(() => engine.sent.length === 1, 'the wake-up to be handed to the session');

        expect(engine.sent[0]).toContain('A child run has finished.');
        expect(engine.sent[0]).toContain('Summary: Result: the footer is fixed');
        await waitFor(() => status() === 'waiting_background', 'the run to wait for the background work alone');

        // The parent's session is the first one and the child's the second: nothing was started to take the message.
        expect(engine.turns).toHaveLength(2);
        expect(pendingMailbox(h.store.db, runId)).toEqual([]);
        expect(notes().filter(text => text.endsWith('finished: succeeded'))).toEqual(['Executor 01 finished: succeeded']);
        expect(h.run(runId).background).toEqual([command]);

        // A Stop closes the one session of the parent once, and the child's own is closed already.
        h.ok('run.cancel', { runId });
        await waitFor(() => engine.closed === 2, 'both sessions to be closed');
        await Bun.sleep(40);
        expect(engine.closed).toBe(2);
        expect(status()).toBe('cancelled');
    });

    test('takes a message of the person into its session while the children work, and waits for them again after the answer', async () => {
        const finished = latch();
        const child = latch();
        const { h, engine, runId, send, status } = await setup(orchestrating({ finished, child }));

        await waitFor(() => status() === 'waiting_children', 'the orchestrator to wait for its child');
        send('Any news');
        await waitFor(() => engine.sent.length === 1, 'the message to reach the session');
        await waitFor(() => status() === 'waiting_children' && h.run(runId).statusReason === 'Waiting for 1 child run', 'the orchestrator to wait for its child again');

        expect(engine.sent).toEqual(['Any news']);
        expect(engine.turns).toHaveLength(2);
        expect(h.run(runId).background).toEqual([command]);
        expect(engine.closed).toBe(0);
    });

    test('is left waiting for its children by a daemon stop, and the turn that the next start gives it tells what the session lost', async () => {
        const finished = latch();
        const child = latch();
        const { h, engine, runId, status } = await setup(orchestrating({ finished, child }));

        await waitFor(() => status() === 'waiting_children' && h.run(runId).background !== undefined, 'the orchestrator to wait for its child');
        await h.stop();

        const second = await restartHarness(h, { engines: scriptEngines(engine) });

        harnesses.push(second);

        // The executor was mid-turn when the daemon went: it is interrupted, and its parent hears of it in a session of its own, as a parent always does.
        await waitFor(() => engine.turns.length === 3 && second.run(runId).status === 'succeeded', 'the parent to be woken by the next start', 8000);
        expect(engine.turns[2]).toMatchObject({ resumeSessionId: 's-1' });
        expect(engine.turns[2].prompt).toContain('interrupted');
        expect(engine.turns[2].prompt).toContain('- command: sleep 60');
        expect(second.run(runId).background).toBeUndefined();
        expect(getRunWork(second.store.db, runId).lostBackground).toBeUndefined();
    });

    test('is parked by its first done when its engine cannot take a prompt after a turn, with no stale list of background work', async () => {
        const finished = latch();
        const child = latch();
        const { h, engine, runId, status } = await setup(orchestrating({ finished, child }), {}, false);

        await waitFor(() => status() === 'waiting_children', 'the orchestrator to wait for its child');
        await waitFor(() => engine.closed === 1, 'the session to be closed');
        expect(h.run(runId).background).toBeUndefined();
        expect(getRunWork(h.store.db, runId).process).toBeUndefined();

        child.release();
        await waitFor(() => engine.turns.length === 3, 'the wake-up to start a session of its own');
        expect(engine.turns[2]).toMatchObject({ resumeSessionId: 's-1' });
    });
});

describe('children started in a turn the agent started', () => {
    test('are waited for while the background work goes on, and their result is handed to the live session', async () => {
        const agentTurn = latch();
        const child = latch();
        const build: BackgroundItem = { id: 'bg-2', kind: 'task', title: 'Build' };
        const { h, engine, runId, status } = await setup(async function* (turn) {
            if (!turn.options.tools.some(tool => tool.name === 'run_spawn')) {
                yield { type: 'session', sessionId: 's-child' };
                await child.wait(turn.signal);
                yield* turn.call('report_result', { status: 'done', summary: 'Result: the footer is fixed' });
                yield { type: 'done' };

                return;
            }

            yield { type: 'session', sessionId: 's-1' };
            yield { type: 'background', items: [command, build] };
            yield { type: 'done', result: 'Started them' };

            if (!await turn.hold(agentTurn)) {
                return;
            }

            // The agent's own turn: the command finished, and the report starts an executor.
            yield { type: 'background', items: [build] };

            const { task } = yield* turn.call('task_create', { title: 'Task 1' });

            yield* turn.call('run_spawn', { taskIds: [task.key], prompt: `Goal: ${ task.key }`, idempotencyKey: 'executor-1' });
            yield { type: 'text', delta: 'Started an executor', done: true };
            yield { type: 'done', result: 'Started an executor' };

            await turn.received();
            yield { type: 'text', delta: 'Got the result', done: true };
            yield { type: 'done', result: 'Got the result' };
            await turn.hold(latch());
        });

        await waitFor(() => status() === 'waiting_background', 'the run to wait for background work');
        agentTurn.release();
        await waitFor(() => status() === 'waiting_children', 'the run to wait for its executor');
        expect(h.run(runId)).toMatchObject({ statusReason: 'Waiting for 1 child run', background: [build] });

        child.release();
        await waitFor(() => engine.sent.length === 1, 'the result of the executor to reach the session');
        expect(engine.sent[0]).toContain('Summary: Result: the footer is fixed');
        await waitFor(() => status() === 'waiting_background' && pendingMailbox(h.store.db, runId).length === 0, 'the run to wait for the build alone');
        expect(engine.turns).toHaveLength(2);
        expect(h.run(runId).background).toEqual([build]);
    });
});

describe('the number of live processes', () => {
    test('does not include a session that waits, and includes it again while it answers a message', async () => {
        const finished = latch();
        const gate = latch();
        const { h, engine, project, send, waits, status } = await setup(lingering({ finished, gates: [gate] }), { maxProcesses: 1 });
        const another = (text: string) => {
            const { chat: created } = h.ok('chat.create', { projectId: project.id }) as { chat: Chat };

            return h.ok('chat.send', { chatId: created.id, text }).runId as string;
        };

        await waits();

        // A session that waits is not counted: another chat starts a session, though the daemon allows one process.
        const second = another('Second');

        await waitFor(() => status(second) === 'succeeded', 'the second chat to run');

        // While it answers a message it is counted: a start now is refused once it has waited for a process to close.
        send('Are you there');
        await waitFor(() => status() === 'running', 'the session to take the message');

        const third = another('Third');

        await waitFor(() => status(third) === 'failed', 'the third chat to be refused');
        expect(h.run(third).error).toBe('1 engine processes are alive, the most this daemon allows (CLOWDY_MAX_PROCESSES); the run was not started');
        expect(engine.turns).toHaveLength(2);

        // Waiting again, it is not counted again.
        gate.release();
        await waitFor(() => status() === 'waiting_background', 'the run to wait again');

        const fourth = another('Fourth');

        await waitFor(() => status(fourth) === 'succeeded', 'the fourth chat to run');
    });
});

describe('sub-agents of the work that waits', () => {
    test('stay alive past the turn while their item is open, take what the agent does in its turns, and end when the item leaves the snapshot', async () => {
        const finished = latch();
        const { h, runId, waits, status, notes } = await setup(async function* (turn) {
            yield { type: 'session', sessionId: 's-1' };
            yield { type: 'subagent', agentId: 'agent-1', parentToolCallId: 'call-1', name: 'Explore', description: 'Look at the callers', state: 'running' };
            yield { type: 'text', delta: 'Looking', done: true, agentId: 'agent-1' };
            yield { type: 'subagent', agentId: 'agent-2', name: 'Foreground', state: 'running' };
            yield { type: 'background', items: [{ id: 'call-1', kind: 'subagent', title: 'Explore' }] };
            yield { type: 'done', result: 'Started it' };

            if (!await turn.hold(finished)) {
                return;
            }

            yield { type: 'text', delta: 'Found three', done: false, agentId: 'agent-1' };
            yield { type: 'text', delta: ' callers', done: true, agentId: 'agent-1' };
            yield { type: 'background', items: [] };
            yield { type: 'text', delta: 'The sub-agent finished', done: true };
            yield { type: 'done', result: 'Reported' };
        });

        await waits();

        const natives = () => projectSnapshot(h.store, h.run(runId).projectId).runs.filter(run => run.origin === 'native');
        const items = (id: string) => listItems(h.store.db, id, 0).map(item => item.body);

        // The one that no item names ended with the turn, as before; the one the snapshot names goes on.
        await waitFor(() => natives().find(run => run.name === 'Foreground')?.status === 'cancelled', 'the unlisted sub-agent to end with the turn');
        expect(natives().find(run => run.name === 'Foreground')).toMatchObject({ statusReason: 'The parent run ended its turn' });
        expect(natives().find(run => run.name === 'Explore')).toMatchObject({ status: 'running', parentToolCallId: 'call-1' });

        finished.release();
        await waitFor(() => status() === 'succeeded', 'the run to end');

        const [explore] = natives().filter(run => run.name === 'Explore');

        expect(explore.status).toBe('succeeded');
        expect(items(explore.id)).toEqual([
            { kind: 'assistant', text: 'Looking', done: true },
            { kind: 'assistant', text: 'Found three callers', done: true },
        ]);
        expect(notes()).toEqual(['Background sub-agent finished: Explore']);
    });

    test('one that stops and is woken at once, out of the list and back in it, is the same sub-agent: no second note, no end in between, and what it says later is not a new one', async () => {
        const finished = latch();
        const input = { subagent_type: 'Explore', description: 'Look at the callers', prompt: 'Find them' };
        const { h, runId, waits, status, notes } = await setup(async function* (turn) {
            const item: BackgroundItem = { id: 'agent-1', kind: 'subagent', title: 'Explore' };
            const card = (state: 'running' | 'done'): EngineEvent => ({ type: 'tool', toolCallId: 'call-1', name: 'Agent', input, state, ...(state === 'done' && { output: 'Reported' }) });

            yield { type: 'session', sessionId: 's-1' };
            yield card('running');
            yield { type: 'subagent', agentId: 'agent-1', parentToolCallId: 'call-1', name: 'Explore', description: 'Look at the callers', state: 'running' };
            yield { type: 'background', items: [item] };
            yield { type: 'done', result: 'Started it' };

            if (!await turn.hold(finished)) {
                return;
            }

            // It stopped (its first report), and its own command woke it a few milliseconds later: the layer says its card is done, the list is
            // empty, the card is running again, and the list has it again. Nothing the agent does comes between, not even the mark that ends its open
            // message, which the layer says when it draws the card again.
            yield { type: 'text', delta: 'First look', done: true, agentId: 'agent-1' };
            yield card('done');
            yield { type: 'background', items: [] };
            yield { type: 'text', delta: '', done: true };
            yield card('running');
            yield { type: 'background', items: [item] };
            yield { type: 'text', delta: 'Second look', done: true, agentId: 'agent-1' };
            yield card('done');
            yield { type: 'background', items: [] };
            yield { type: 'text', delta: 'Reported', done: true };
            // Anything it says after it is over is dropped, not taken for a sub-agent of its own.
            yield { type: 'tool', toolCallId: 'late-1', name: 'Read', input: {}, state: 'running', agentId: 'agent-1' };
            yield { type: 'done', result: 'Reported' };
        });

        await waits();

        const natives = () => projectSnapshot(h.store, h.run(runId).projectId).runs.filter((run: Run) => run.origin === 'native');
        const items = (id: string) => listItems(h.store.db, id, 0).map(item => item.body);

        finished.release();
        await waitFor(() => status() === 'succeeded', 'the run to end');

        const [explore] = natives();

        expect(natives()).toHaveLength(1);
        // It ended once, after its last word, and its result is the last thing it said.
        expect(explore).toMatchObject({ status: 'succeeded', result: 'Second look', parentToolCallId: 'call-1' });
        expect(items(explore.id)).toEqual([{ kind: 'assistant', text: 'First look', done: true }, { kind: 'assistant', text: 'Second look', done: true }]);
        expect(notes()).toEqual(['Background sub-agent finished: Explore']);
        expect(items(runId).filter(body => body.kind === 'tool')).toEqual([expect.objectContaining({ toolCallId: 'call-1', state: 'done', output: 'Reported' })]);
    });

    test('one that the list names before its first event comes still ends as finished when its item leaves, not as cancelled with the session', async () => {
        const finished = latch();
        const { h, runId, waits, status, notes } = await setup(async function* (turn) {
            yield { type: 'session', sessionId: 's-1' };
            yield { type: 'background', items: [{ id: 'call-1', kind: 'subagent', title: 'Explore' }] };
            yield { type: 'subagent', agentId: 'agent-1', parentToolCallId: 'call-1', name: 'Explore', state: 'running' };
            yield { type: 'text', delta: 'Looking', done: true, agentId: 'agent-1' };
            yield { type: 'done', result: 'Started it' };

            if (!await turn.hold(finished)) {
                return;
            }

            yield { type: 'background', items: [] };
            yield { type: 'text', delta: 'The sub-agent finished', done: true };
            yield { type: 'done', result: 'Reported' };
        });

        await waits();
        finished.release();
        await waitFor(() => status() === 'succeeded', 'the run to end');

        expect(projectSnapshot(h.store, h.run(runId).projectId).runs.filter((run: Run) => run.origin === 'native').map(run => run.status)).toEqual(['succeeded']);
        expect(notes()).toEqual(['Background sub-agent finished: Explore']);
    });

    test('one whose item is lost as the agent says nothing more ends as finished with the session, with its note', async () => {
        const finished = latch();
        const { h, runId, waits, status, notes } = await setup(async function* (turn) {
            yield { type: 'session', sessionId: 's-1' };
            yield { type: 'subagent', agentId: 'agent-1', parentToolCallId: 'call-1', name: 'Explore', state: 'running' };
            yield { type: 'text', delta: 'Looking', done: true, agentId: 'agent-1' };
            yield { type: 'background', items: [{ id: 'call-1', kind: 'subagent', title: 'Explore' }] };
            yield { type: 'done', result: 'Started it' };

            if (!await turn.hold(finished)) {
                return;
            }

            // The list loses it and the agent never speaks again: the session ends.
            yield { type: 'background', items: [] };
        });

        await waits();
        finished.release();
        await waitFor(() => status() === 'succeeded', 'the run to end');

        expect(projectSnapshot(h.store, h.run(runId).projectId).runs.filter((run: Run) => run.origin === 'native')).toEqual([expect.objectContaining({ status: 'succeeded', result: 'Looking' })]);
        expect(notes()).toEqual(['Background sub-agent finished: Explore']);
    });

    test('one whose item is lost while the turn goes on ends when the agent does something next, and with the turn when it does nothing', async () => {
        const { h, runId, status, notes } = await setup(async function* () {
            const item = (id: string): BackgroundItem => ({ id, kind: 'subagent', title: id });

            yield { type: 'session', sessionId: 's-1' };
            yield { type: 'subagent', agentId: 'a', name: 'First', state: 'running' };
            yield { type: 'subagent', agentId: 'b', name: 'Second', state: 'running' };
            yield { type: 'background', items: [item('a'), item('b')] };
            yield { type: 'background', items: [item('b')] };
            yield { type: 'text', delta: 'Moving on', done: true };
            yield { type: 'background', items: [] };
            yield { type: 'done', result: 'Done' };
        });

        await waitFor(() => status() === 'succeeded', 'the run to end');

        const natives = projectSnapshot(h.store, h.run(runId).projectId).runs.filter((run: Run) => run.origin === 'native');

        // Both finished, none was cancelled by the turn's end, each has its note, in the order they went.
        expect(natives.map(run => [run.name, run.status])).toEqual([['First', 'succeeded'], ['Second', 'succeeded']]);
        expect(notes()).toEqual(['Background sub-agent finished: a', 'Background sub-agent finished: b']);
    });

    test('its card in the parent\'s stream is not failed by the end of the turn, and ends with the sub-agent', async () => {
        const finished = latch();
        const input = { subagent_type: 'Explore', description: 'Look at the callers', prompt: 'Find them' };
        const { h, runId, waits, status } = await setup(async function* (turn) {
            yield { type: 'session', sessionId: 's-1' };
            yield { type: 'tool', toolCallId: 'call-1', name: 'Agent', input, state: 'running' };
            yield { type: 'subagent', agentId: 'agent-1', parentToolCallId: 'call-1', name: 'Explore', description: 'Look at the callers', state: 'running' };
            yield { type: 'tool', toolCallId: 'call-2', name: 'Read', input: {}, state: 'running' };
            yield { type: 'background', items: [{ id: 'agent-1', kind: 'subagent', title: 'Explore' }] };
            yield { type: 'done', result: 'Started it' };

            if (!await turn.hold(finished)) {
                return;
            }

            yield { type: 'tool', toolCallId: 'call-1', name: 'Agent', input, state: 'done', output: 'Three callers' };
            yield { type: 'background', items: [] };
            yield { type: 'text', delta: 'It found three', done: true };
            yield { type: 'done', result: 'Reported' };
        });

        await waits();

        const tools = () => listItems(h.store.db, runId, 0).flatMap(item => item.body.kind === 'tool' ? [[item.body.toolCallId, item.body.state]] : []);

        // The sub-agent's call goes on, another call the turn left running is failed as before.
        expect(tools()).toEqual([['call-1', 'running'], ['call-2', 'error']]);

        finished.release();
        await waitFor(() => status() === 'succeeded', 'the run to end');
        expect(tools()).toEqual([['call-1', 'done'], ['call-2', 'error']]);
    });

    test('a Stop while one works ends its run and its card as stopped', async () => {
        const finished = latch();
        const { h, runId, waits } = await setup(async function* (turn) {
            yield { type: 'session', sessionId: 's-1' };
            yield { type: 'tool', toolCallId: 'call-1', name: 'Agent', input: {}, state: 'running' };
            yield { type: 'subagent', agentId: 'agent-1', parentToolCallId: 'call-1', name: 'Explore', state: 'running' };
            yield { type: 'text', delta: 'Working', done: true, agentId: 'agent-1' };
            yield { type: 'background', items: [{ id: 'agent-1', kind: 'subagent', title: 'Explore' }] };
            yield { type: 'done', result: 'Started it' };
            await turn.hold(finished);
        });

        await waits();
        h.ok('run.cancel', { runId });
        await waitFor(() => h.run(runId).status === 'cancelled', 'the run to stop');

        const natives = () => projectSnapshot(h.store, h.run(runId).projectId).runs.filter((run: Run) => run.origin === 'native');
        const card = () => listItems(h.store.db, runId, 0).flatMap(item => item.body.kind === 'tool' ? [item.body] : []);

        // The session's end closes both, a moment after the run is cancelled.
        await waitFor(() => card()[0]?.state === 'error' && natives()[0]?.status === 'cancelled', 'the card and the sub-agent to end');
        expect(card()).toEqual([expect.objectContaining({ toolCallId: 'call-1', state: 'error', error: STOPPED_TOOL })]);
    });

    test('end with the run when it is stopped while they work', async () => {
        const finished = latch();
        const { h, runId, waits } = await setup(async function* (turn) {
            yield { type: 'session', sessionId: 's-1' };
            yield { type: 'subagent', agentId: 'agent-1', name: 'Explore', state: 'running' };
            yield { type: 'background', items: [{ id: 'agent-1', kind: 'subagent', title: 'Explore' }] };
            yield { type: 'done', result: 'Started it' };
            await turn.hold(finished);
        });

        await waits();

        const natives = () => projectSnapshot(h.store, h.run(runId).projectId).runs.filter((run: Run) => run.origin === 'native');

        expect(natives()[0].status).toBe('running');
        h.ok('run.cancel', { runId });
        await waitFor(() => natives()[0].status === 'cancelled', 'the sub-agent to end with the run');
    });
});
