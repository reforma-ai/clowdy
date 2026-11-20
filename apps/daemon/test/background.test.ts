import { STOPPED_TOOL } from '@clowdy/protocol';
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';

import { executeCommand } from '../src/commands';
import { getChat } from '../src/db/chats';
import { listItems } from '../src/db/items';
import { getRunWork, runningCounts } from '../src/db/runs';
import { projectSnapshot } from '../src/domain/snapshots';
import { cleanTempDirs, latch, command as makeCommand, restartHarness, ScriptEngine, scriptEngines, startHarness, waitFor } from './helpers';

import type { BackgroundItem, Chat, ChatMode, Run, RunStatus } from '@clowdy/protocol';
import type { EngineEvent } from '../src/engine/types';
import type { Harness, Script, Turn } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];
const pids: number[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));

    for (const pid of pids.splice(0)) {
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
    pids.push(child.pid!);

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

async function setup(script: Script, overrides: Parameters<typeof startHarness>[0] = {}, answers: ScriptEngine['sendAnswer'] | false = () => true, mode?: ChatMode, stops?: ScriptEngine['stopAnswer']) {
    const engine = new ScriptEngine(script);

    if (answers) {
        engine.sendAnswer = answers;
    }

    if (stops) {
        engine.stopAnswer = stops;
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

        expect(refusals).toEqual(['Can\'t ask a question while the run waits for background work']);
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

describe('the notes of a monitor and a wakeup whose time came', () => {
    const monitor: BackgroundItem = { id: 'toolu-monitor-1', kind: 'task', title: 'Monitor · Tick monitor probe' };
    const wakeup: BackgroundItem = { id: 'toolu-wakeup-2', kind: 'task', title: 'Wakeup · Check the deploy' };

    test('say that its time is over, as nothing tells what came of it, and a task of another sort is a task that finished', async () => {
        const other: BackgroundItem = { id: 'wf-1', kind: 'task', title: 'Workflow: verify' };
        const { notes, status } = await setup(async function* () {
            yield { type: 'session', sessionId: 's-1' };
            yield { type: 'background', items: [monitor, wakeup, other] };
            yield { type: 'done', result: 'Armed them' };
            yield { type: 'background', items: [wakeup, other] };
            yield { type: 'background', items: [other] };
            yield { type: 'background', items: [] };
            yield { type: 'text', delta: 'Heard from them', done: true };
            yield { type: 'done', result: 'Heard from them' };
        });

        await waitFor(() => status() === 'succeeded', 'the run to end');
        expect(notes()).toEqual(['Monitor ended: Tick monitor probe', 'Wakeup due: Check the deploy', 'Background task finished: Workflow: verify']);
    });

    test('a run waits for one: the item is on the run, and a Stop loses it with the session and tells the agent to start it again', async () => {
        const finished = latch();
        const { h, engine, runId, send, waits, status } = await setup(lingering({ finished, items: [monitor] }));

        await waits();
        expect(h.run(runId)).toMatchObject({ statusReason: 'Waiting for background work', background: [monitor] });

        h.ok('run.cancel', { runId });
        await waitFor(() => engine.closed === 1 && getRunWork(h.store.db, runId).lostBackground, 'the session to be closed and what it lost to be kept');
        expect(getRunWork(h.store.db, runId).lostBackground).toEqual([monitor]);

        send('Where were we');
        await waitFor(() => status() === 'succeeded' && engine.turns.length === 2, 'the message to run in a new session');

        expect(engine.turns[1].prompt).toContain('Start it again if it is still needed');
        expect(engine.turns[1].prompt).toContain('- task: Monitor · Tick monitor probe');
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

    test('one that the end of the turn cancelled is not made again by what it says after: its words are dropped, with no second run', async () => {
        const finished = latch();
        const { h, runId, waits, status } = await setup(async function* (turn) {
            yield { type: 'session', sessionId: 's-1' };
            yield { type: 'subagent', agentId: 'agent-1', name: 'Explore', state: 'running' };
            // Only a command is open, so the turn's end cancels the sub-agent no item names, and the session goes on waiting.
            yield { type: 'background', items: [command] };
            yield { type: 'done', result: 'Started it' };
            yield { type: 'text', delta: 'Still looking', done: true, agentId: 'agent-1' };
            yield { type: 'subagent', agentId: 'agent-1', name: 'Explore', state: 'running' };
            await turn.hold(finished);
            yield { type: 'background', items: [] };
            yield { type: 'done', result: 'All finished' };
        });

        await waits();
        finished.release();
        await waitFor(() => status() === 'succeeded', 'the run to end');

        // What it said after was read (the session's end applies it), and made nothing.
        expect(projectSnapshot(h.store, h.run(runId).projectId).runs.filter((run: Run) => run.origin === 'native')).toEqual([
            expect.objectContaining({ name: 'Explore', status: 'cancelled', statusReason: 'The parent run ended its turn' }),
        ]);
    });
});

/** The sub-agents of a chat's orchestrator the script below starts: each has a call that started it, a child run, and an item in the list. */
const agentCall = (n: number) => ({ id: `call-${ n }`, agentId: `agent-${ n }` });
const agentItem = (n: number): BackgroundItem => ({ id: agentCall(n).id, kind: 'subagent', title: `Explore ${ n }` });

/** The events that start sub-agent `n`, as the v2 layer tells them: its card, and the child run the card names, which its agent lets the client stop. */
function* starts(n: number, stoppable = true): Generator<EngineEvent> {
    const { id, agentId } = agentCall(n);

    yield { type: 'tool', toolCallId: id, name: 'Agent', input: { description: `Explore ${ n }` }, state: 'running' };
    yield { type: 'subagent', agentId, parentToolCallId: id, name: 'Explore', description: `Explore ${ n }`, state: 'running', ...(stoppable && { stoppable }) };
}

interface Stopping {
    /** How many sub-agents the first turn starts. */
    count: number;
    /** Released by the test when the rest of the work ends: the session reports and ends. */
    finished: Latch;
    /** What a sub-agent that was asked to stop does: the agent says so (the default), or it finishes first (`done`). */
    outcome?: 'cancelled' | 'done';
    /** Whether the sub-agents say they may be stopped alone. */
    stoppable?: boolean;
    /** The first turn goes on until the test releases this (the orchestrator's turn runs while a sub-agent is stopped). */
    turn?: Latch;
}

/**
 * An orchestrator that starts background sub-agents and keeps its session for them. When the runtime asks it to stop one, it answers as the v2 layer does for
 * Claude Code: the sub-agent's end (`cancelled`, or `done` when it was finishing anyway), its card ended as stopped, and the list without it. What the agent says
 * of it follows when the list changed.
 */
function stopping(plan: Stopping): Script {
    return async function* (turn) {
        yield { type: 'session', sessionId: 's-1' };

        if (turn.number > 1) {
            yield { type: 'text', delta: 'Back again', done: true };
            yield { type: 'done', result: 'Back again' };

            return;
        }

        const open = new Map<number, BackgroundItem>();

        for (let n = 1; n <= plan.count; n++) {
            yield* starts(n, plan.stoppable);
            open.set(n, agentItem(n));
        }

        yield { type: 'text', delta: 'Started them', done: true };

        yield { type: 'background', items: [...open.values()] };

        if (plan.turn && !await turn.hold(plan.turn)) {
            return;
        }

        yield { type: 'done', result: 'Started them' };

        let stop = turn.stopRequested();
        const finished = turn.hold(plan.finished);

        for (;;) {
            const next = await Promise.race([stop.then(agentId => ({ agentId })), finished.then(released => ({ released }))]);

            if ('agentId' in next) {
                if (next.agentId === undefined) {
                    return;
                }

                const n = Number(next.agentId.replace('agent-', ''));
                const { id, agentId } = agentCall(n);

                if (open.delete(n)) {
                    if ((plan.outcome ?? 'cancelled') === 'cancelled') {
                        yield { type: 'tool', toolCallId: id, name: 'Agent', input: {}, state: 'error', error: STOPPED_TOOL };
                        yield { type: 'subagent', agentId, parentToolCallId: id, name: 'Explore', state: 'cancelled' };
                    }
                    else {
                        yield { type: 'tool', toolCallId: id, name: 'Agent', input: {}, state: 'done', output: 'It finished' };
                        yield { type: 'subagent', agentId, parentToolCallId: id, name: 'Explore', state: 'done', summary: 'It finished' };
                    }

                    yield { type: 'background', items: [...open.values()] };
                    yield { type: 'text', delta: `Sub-agent ${ n } is over`, done: true };
                    yield { type: 'done', result: `Sub-agent ${ n } is over` };
                }

                stop = turn.stopRequested();
            }
            else {
                if (next.released) {
                    for (const [n] of open) {
                        const { id, agentId } = agentCall(n);

                        yield { type: 'tool', toolCallId: id, name: 'Agent', input: {}, state: 'done', output: 'Done' };
                        yield { type: 'subagent', agentId, parentToolCallId: id, name: 'Explore', state: 'done', summary: 'Done' };
                    }

                    yield { type: 'background', items: [] };
                    yield { type: 'text', delta: 'All finished', done: true };
                    yield { type: 'done', result: 'All finished' };
                }

                return;
            }
        }
    };
}

describe('stopping one sub-agent of the work that waits', () => {
    const natives = (h: Harness, runId: string) => projectSnapshot(h.store, h.run(runId).projectId).runs.filter((run: Run) => run.origin === 'native');
    const native = (h: Harness, runId: string, n: number) => natives(h, runId).find(run => run.parentToolCallId === agentCall(n).id) as Run;
    const card = (h: Harness, runId: string, n: number) => listItems(h.store.db, runId, 0).flatMap(item => item.body.kind === 'tool' && item.body.toolCallId === agentCall(n).id ? [item.body] : []);
    const stopsAlone = () => true;

    test('ends that sub-agent alone: its run is cancelled by the agent\'s own event, its card ends as stopped, and the run, the other sub-agent and the list go on', async () => {
        const finished = latch();
        const { h, engine, runId, waits, status, notes, history } = await setup(stopping({ count: 2, finished }), {}, () => true, undefined, stopsAlone);

        await waits();

        const [first, second] = [native(h, runId, 1), native(h, runId, 2)];

        expect([first.canStopAlone, second.canStopAlone]).toEqual([true, true]);

        // The answer does not wait for the end: the request goes out, and the run ends through the event the agent gives back.
        expect(h.ok('run.cancel', { runId: first.id })).toEqual({ cancelled: [first.id] });
        await waitFor(() => h.run(first.id).status === 'cancelled', 'the sub-agent to be cancelled');

        expect(engine.stopRequests).toEqual(['agent-1']);
        expect(h.run(first.id)).toMatchObject({ status: 'cancelled', statusReason: 'Cancelled by user' });
        expect(h.run(second.id).status).toBe('running');
        expect(card(h, runId, 1)).toEqual([expect.objectContaining({ state: 'error', error: STOPPED_TOOL })]);
        expect(card(h, runId, 2)).toEqual([expect.objectContaining({ state: 'running' })]);

        // The run waits on, with what is left in its list, and was not cancelled; the agent said what happened and the note names it as stopped.
        await waitFor(() => notes().length > 0, 'the note');
        expect(notes()).toEqual(['Background sub-agent stopped: Explore 1']);
        expect(status()).toBe('waiting_background');
        expect(h.run(runId).background).toEqual([agentItem(2)]);
        expect(history()).toEqual(['queued', 'running', 'waiting_background']);

        finished.release();
        await waitFor(() => status() === 'succeeded', 'the run to end');
        expect(h.run(second.id).status).toBe('succeeded');
        expect(h.run(first.id).status).toBe('cancelled');
    });

    test('is not a Stop of the run: the chat is not held, and a message sent after it reaches the same session', async () => {
        const finished = latch();
        const { h, engine, chat, runId, send, waits, said } = await setup(stopping({ count: 2, finished }), {}, () => true, undefined, stopsAlone);

        await waits();
        h.ok('run.cancel', { runId: native(h, runId, 1).id });
        await waitFor(() => h.run(native(h, runId, 1).id).status === 'cancelled', 'the sub-agent to be cancelled');
        await waitFor(() => h.run(runId).status === 'waiting_background', 'the run to wait again');

        expect(getChat(h.store.db, chat.id)?.queuePaused).toBeUndefined();
        send('Carry on');
        await waitFor(() => engine.sent.includes('Carry on'), 'the message to reach the live session');
        expect(said()).toContain('Carry on');
        expect(engine.turns).toHaveLength(1);
        finished.release();
        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to end');
    });

    test('works while the orchestrator\'s own turn runs, and the turn goes on to its end', async () => {
        const finished = latch();
        const gate = latch();
        const { h, engine, runId, status } = await setup(stopping({ count: 2, finished, turn: gate }), {}, () => true, undefined, stopsAlone);

        await waitFor(() => natives(h, runId).length === 2, 'both sub-agents');
        expect(status()).toBe('running');

        h.ok('run.cancel', { runId: native(h, runId, 2).id });
        // The agent hears the request while its turn runs; it answers when it gets to it, here when the turn has said done.
        await waitFor(() => engine.stopRequests.length === 1, 'the request to reach the session');
        expect(status()).toBe('running');
        gate.release();
        await waitFor(() => h.run(native(h, runId, 2).id).status === 'cancelled', 'the sub-agent to be cancelled');
        await waitFor(() => status() === 'waiting_background', 'the run to wait');
        expect(h.run(native(h, runId, 1).id).status).toBe('running');
        finished.release();
        await waitFor(() => status() === 'succeeded', 'the run to end');
    });

    test('asks the agent only once the stopping transaction has committed: a Stop that rolls back sends nothing and leaves every sub-agent running', async () => {
        const finished = latch();
        const { h, engine, runId, waits } = await setup(stopping({ count: 2, finished }), {}, () => true, undefined, stopsAlone);

        await waits();

        const [first, second] = [native(h, runId, 1), native(h, runId, 2)];
        const { runs } = h.daemon.services;
        const rollBack = (stop: () => unknown) => h.store.tx(() => {
            stop();
            throw new Error('rolled back');
        });

        expect(() => rollBack(() => runs.cancel(first.id))).toThrow('rolled back');
        expect(() => rollBack(() => runs.stopAgents(runId))).toThrow('rolled back');
        await Bun.sleep(50);
        expect(engine.stopRequests).toEqual([]);
        expect([h.run(first.id).status, h.run(second.id).status, h.run(runId).status]).toEqual(['running', 'running', 'waiting_background']);

        // Committed, each sub-agent is asked once.
        h.ok('run.stopAgents', { runId });
        await waitFor(() => h.run(first.id).status === 'cancelled' && h.run(second.id).status === 'cancelled', 'both sub-agents to be stopped');
        expect([...engine.stopRequests].sort()).toEqual(['agent-1', 'agent-2']);
        finished.release();
        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to end');
    });

    test('a Stop all sent again with the same request id is answered from the first one and asks nobody twice', async () => {
        const finished = latch();
        const { h, engine, runId, waits } = await setup(stopping({ count: 2, finished }), {}, () => true, undefined, stopsAlone);

        await waits();

        const stop = makeCommand('run.stopAgents', { runId });
        const first = executeCommand(h.daemon.services, stop);

        expect(first).toMatchObject({ ok: true, data: { stopped: expect.any(Array) } });
        expect(executeCommand(h.daemon.services, stop)).toEqual(first);
        await waitFor(() => engine.stopRequests.length === 2, 'both requests');
        await Bun.sleep(50);
        expect([...engine.stopRequests].sort()).toEqual(['agent-1', 'agent-2']);
        finished.release();
        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to end');
    });

    test('a sub-agent that finishes by itself while the request is on its way ends as finished, and the Stop changes nothing', async () => {
        const finished = latch();
        const { h, engine, runId, waits, status } = await setup(stopping({ count: 2, finished, outcome: 'done' }), {}, () => true, undefined, stopsAlone);

        await waits();
        h.ok('run.cancel', { runId: native(h, runId, 1).id });
        await waitFor(() => engine.stopRequests.length === 1 && h.run(native(h, runId, 1).id).status !== 'running', 'the sub-agent to end');
        expect(h.run(native(h, runId, 1).id)).toMatchObject({ status: 'succeeded', result: 'It finished' });
        // A Stop of a run that is over cancels nothing.
        expect(h.ok('run.cancel', { runId: native(h, runId, 1).id })).toEqual({ cancelled: [] });
        expect(status()).toBe('waiting_background');
        finished.release();
        await waitFor(() => status() === 'succeeded', 'the run to end');
    });

    test('two Stops of one sub-agent in a row end it once', async () => {
        const finished = latch();
        const { h, engine, runId, waits, status, history } = await setup(stopping({ count: 2, finished }), {}, () => true, undefined, stopsAlone);

        await waits();

        const first = native(h, runId, 1);

        expect(h.ok('run.cancel', { runId: first.id })).toEqual({ cancelled: [first.id] });
        expect(h.ok('run.cancel', { runId: first.id })).toEqual({ cancelled: [first.id] });
        await waitFor(() => h.run(first.id).status === 'cancelled', 'the sub-agent to be cancelled');
        // The second request finds it over: the run is a finished one, and cancels nothing.
        expect(h.ok('run.cancel', { runId: first.id })).toEqual({ cancelled: [] });
        expect(engine.stopRequests.slice(0, 2)).toEqual(['agent-1', 'agent-1']);
        expect(history(first.id)).toEqual(['running', 'cancelled']);
        expect(status()).toBe('waiting_background');
        finished.release();
        await waitFor(() => status() === 'succeeded', 'the run to end');
    });

    test('a Stop of the whole run at the same time ends everything, the sub-agent once and the session closed', async () => {
        const finished = latch();
        const { h, engine, runId, waits } = await setup(stopping({ count: 2, finished }), {}, () => true, undefined, stopsAlone);

        await waits();

        const first = native(h, runId, 1);

        h.ok('run.cancel', { runId: first.id });
        const { cancelled } = h.ok('run.cancel', { runId });

        expect(new Set(cancelled)).toEqual(new Set([native(h, runId, 2).id, first.id, runId]));
        expect(h.run(runId).status).toBe('cancelled');
        await waitFor(() => natives(h, runId).every(run => run.status === 'cancelled') && engine.closed === 1, 'everything to end');
        // Its sub-agents are over: a Stop of one now cancels nothing, and nothing is asked of the closed session.
        expect(h.ok('run.cancel', { runId: first.id })).toEqual({ cancelled: [] });
    });

    test('is refused with the old words when the sub-agent did not say it can be stopped alone, though the engine can', async () => {
        const finished = latch();
        const { h, runId, waits, status } = await setup(stopping({ count: 1, finished, stoppable: false }), {}, () => true, undefined, stopsAlone);

        await waits();
        expect(native(h, runId, 1).canStopAlone).toBeUndefined();
        expect(h.send('run.cancel', { runId: native(h, runId, 1).id })).toMatchObject({ ok: false, error: { code: 'conflict', message: expect.stringContaining('cancel the parent run instead') } });
        expect(status()).toBe('waiting_background');
        finished.release();
        await waitFor(() => status() === 'succeeded', 'the run to end');
    });

    test('is refused when the engine cannot end one sub-agent alone, though the sub-agent says it can', async () => {
        const finished = latch();
        const { h, runId, waits, status } = await setup(stopping({ count: 1, finished }), {}, () => true);

        await waits();
        expect(native(h, runId, 1).canStopAlone).toBeUndefined();
        expect(h.send('run.cancel', { runId: native(h, runId, 1).id })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        finished.release();
        await waitFor(() => status() === 'succeeded', 'the run to end');
    });

    test('after a Stop of the run its sub-agents are cancelled with it, and a Stop of one of them cancels nothing', async () => {
        const finished = latch();
        const { h, runId, waits } = await setup(stopping({ count: 1, finished }), {}, () => true, undefined, stopsAlone);

        await waits();
        h.ok('run.cancel', { runId });
        await waitFor(() => native(h, runId, 1).status === 'cancelled', 'the sub-agent to end with the run');
        expect(h.ok('run.cancel', { runId: native(h, runId, 1).id })).toEqual({ cancelled: [] });
    });

    test('an engine that refuses the request leaves the sub-agent running, and a Stop again asks again', async () => {
        const finished = latch();
        let answers = 0;
        const { h, engine, runId, waits } = await setup(stopping({ count: 1, finished }), {}, () => true, undefined, () => ++answers > 1);

        await waits();

        const first = native(h, runId, 1);

        h.ok('run.cancel', { runId: first.id });
        await waitFor(() => engine.stopRequests.length === 1, 'the first request');
        await Bun.sleep(50);
        expect(h.run(first.id).status).toBe('running');
        h.ok('run.cancel', { runId: first.id });
        await waitFor(() => h.run(first.id).status === 'cancelled', 'the second request to end it');
        expect(engine.stopRequests).toEqual(['agent-1', 'agent-1']);
        finished.release();
        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to end');
    });
});

describe('stopping the agents of a run that waits, and nothing else', () => {
    /** A sub-agent that can be stopped alone next to one that cannot: an orchestrator with both, whose session stays for them. */
    function mixed(options: { finished: Latch }): Script {
        return async function* (turn) {
            yield { type: 'session', sessionId: 's-1' };
            yield* starts(1);
            yield* starts(2, false);
            yield { type: 'background', items: [agentItem(1), agentItem(2)] };
            yield { type: 'done', result: 'Started them' };

            let stop = turn.stopRequested();
            const finished = turn.hold(options.finished);

            for (;;) {
                const next = await Promise.race([stop.then(agentId => ({ agentId })), finished.then(released => ({ released }))]);

                if (!('agentId' in next) || next.agentId === undefined) {
                    return;
                }

                yield { type: 'subagent', agentId: next.agentId, parentToolCallId: agentCall(1).id, name: 'Explore', state: 'cancelled' };
                yield { type: 'background', items: [agentItem(2)] };
                stop = turn.stopRequested();
            }
        };
    }

    test('asks the sub-agents that can stop alone to stop, and leaves the run and the sub-agent that cannot', async () => {
        const finished = latch();
        const { h, engine, chat, runId, status, history, waits } = await setup(mixed({ finished }), {}, () => true, undefined, () => true);
        const natives = () => projectSnapshot(h.store, h.run(runId).projectId).runs.filter((run: Run) => run.origin === 'native');

        await waits();
        await waitFor(() => natives().length === 2, 'both sub-agents');

        const [stoppable, fixed] = natives();
        const { stopped } = h.ok('run.stopAgents', { runId });

        // Everything that can stop is asked once; the run itself is untouched, and so is the sub-agent that cannot stop alone.
        expect(stopped).toEqual([stoppable.id]);
        expect(h.run(runId).status).not.toBe('cancelled');
        await waitFor(() => h.run(stoppable.id).status === 'cancelled', 'the sub-agent to be stopped');
        expect(h.run(stoppable.id).statusReason).toBe('Cancelled by user');
        expect(engine.stopRequests).toEqual(['agent-1']);
        expect(h.run(fixed.id).status).toBe('running');
        expect(getChat(h.store.db, chat.id)?.queuePaused).toBeUndefined();

        // The run waits on for what is left, and was never cancelled.
        await waitFor(() => h.run(runId).background?.length === 1, 'the list without the stopped sub-agent');
        expect(status()).toBe('waiting_background');
        expect(h.run(runId).background).toEqual([agentItem(2)]);
        expect(history()).not.toContain('cancelled');

        finished.release();
        await waitFor(() => status() === 'succeeded', 'the run to end');
    });

    test('says nothing was stopped for a run with no agent to stop, and for one that is over', async () => {
        const finished = latch();
        const { h, runId, waits } = await setup(stopping({ count: 1, finished, stoppable: false }), {}, () => true, undefined, () => true);

        await waits();
        expect(h.ok('run.stopAgents', { runId })).toEqual({ stopped: [] });
        expect(h.run(runId).status).toBe('waiting_background');
        h.ok('run.cancel', { runId });
        await waitFor(() => h.run(runId).status === 'cancelled', 'the run to stop');
        expect(h.ok('run.stopAgents', { runId })).toEqual({ stopped: [] });
        expect(h.send('run.stopAgents', { runId: 'run_nope' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    });
});

describe('a sub-agent of a sub-agent', () => {
    const middle: BackgroundItem = { id: 'call-M', kind: 'subagent', title: 'Middle' };
    const natives = (h: Harness, runId: string) => projectSnapshot(h.store, h.run(runId).projectId).runs.filter((run: Run) => run.origin === 'native');
    const named = (h: Harness, runId: string, name: string) => natives(h, runId).find(run => run.summary === name) as Run;
    const stream = (h: Harness, id: string) => listItems(h.store.db, id, 0).map(item => item.body);

    /**
     * The sub-agent M is started in the first turn and listed. While the session waits it starts G1 and G2 of its own, as Claude's adapter tells it: the
     * grandchildren are announced by M (`parentAgentId`), their calls are cards in M's stream, and the session's list names M only. An agent-started turn
     * then ends while they work. A request to stop one is answered with that sub-agent's end alone, as the adapter does (it leaves the sub-agents it started working).
     * What the agent says of the others follows when the test releases `finished`: G1 and G2 end, then M.
     */
    function nesting(options: { finished: Latch }): Script {
        return async function* (turn) {
            yield { type: 'session', sessionId: 's-1' };

            if (turn.number > 1) {
                yield { type: 'text', delta: 'Back again', done: true };
                yield { type: 'done', result: 'Back again' };

                return;
            }

            yield { type: 'tool', toolCallId: 'call-M', name: 'Agent', input: { description: 'Middle' }, state: 'running' };
            yield { type: 'subagent', agentId: 'agent-M', parentToolCallId: 'call-M', name: 'Explore', description: 'Middle', state: 'running', stoppable: true };
            yield { type: 'background', items: [middle] };
            yield { type: 'text', delta: 'Started it', done: true };
            yield { type: 'done', result: 'Started it' };

            const open = new Set(['agent-M', 'agent-G1', 'agent-G2']);

            for (const n of [1, 2]) {
                yield { type: 'tool', toolCallId: `call-G${ n }`, name: 'Agent', input: { description: `Grand ${ n }` }, state: 'running', agentId: 'agent-M' };
                yield { type: 'subagent', agentId: `agent-G${ n }`, parentAgentId: 'agent-M', parentToolCallId: `call-G${ n }`, name: 'Explore', description: `Grand ${ n }`, state: 'running', stoppable: true };
                yield { type: 'text', delta: `Working on ${ n }`, done: true, agentId: `agent-G${ n }` };
            }

            // A turn the agent starts by itself ends while they work: nothing is cancelled with it.
            yield { type: 'text', delta: 'Still working', done: true };
            yield { type: 'done', result: 'Still working' };

            const end = (agentId: string, state: 'cancelled' | 'done') => ({ type: 'subagent', agentId, ...(agentId !== 'agent-M' && { parentAgentId: 'agent-M' }), parentToolCallId: `call-${ agentId.slice(-2) }`, name: 'Explore', state, ...(state === 'done' && { summary: 'Done' }) }) as EngineEvent;
            let stop = turn.stopRequested();
            const finished = turn.hold(options.finished);

            for (;;) {
                const next = await Promise.race([stop.then(agentId => ({ agentId })), finished.then(released => ({ released }))]);

                if ('agentId' in next) {
                    if (next.agentId === undefined) {
                        return;
                    }

                    if (open.delete(next.agentId)) {
                        yield end(next.agentId, 'cancelled');
                        yield { type: 'background', items: open.has('agent-M') || open.size > 0 ? [middle] : [] };
                    }

                    stop = turn.stopRequested();
                }
                else {
                    if (next.released) {
                        for (const agentId of ['agent-G1', 'agent-G2', 'agent-M']) {
                            if (open.delete(agentId)) {
                                yield end(agentId, 'done');
                            }
                        }

                        yield { type: 'background', items: [] };
                        yield { type: 'text', delta: 'All finished', done: true };
                        yield { type: 'done', result: 'All finished' };
                    }

                    return;
                }
            }
        };
    }

    const started = (h: Harness, runId: string) => waitFor(() => natives(h, runId).length === 3 && natives(h, runId).every(run => run.status === 'running') && stream(h, runId).filter(body => body.kind === 'assistant').length >= 2, 'the three sub-agents and the turn that ends while they work');

    test('its run hangs from the run of the sub-agent that started it, with the same root, its card is in that one\'s stream, and it is kept while that one is listed', async () => {
        const finished = latch();
        const { h, runId, status, notes } = await setup(nesting({ finished }), {}, () => true, undefined, () => true);

        await started(h, runId);

        const [m, g1, g2] = [named(h, runId, 'Middle'), named(h, runId, 'Grand 1'), named(h, runId, 'Grand 2')];

        expect([m.parentRunId, g1.parentRunId, g2.parentRunId]).toEqual([runId, m.id, m.id]);
        expect([m.rootRunId, g1.rootRunId, g2.rootRunId]).toEqual([runId, runId, runId]);
        expect([m.canStopAlone, g1.canStopAlone, g2.canStopAlone]).toEqual([true, true, true]);
        expect(status()).toBe('waiting_background');
        expect(h.run(runId).background).toEqual([middle]);
        // The cards of the grandchildren are in the stream of the sub-agent that started them, and the middle one's in the run's.
        expect(stream(h, m.id).flatMap(body => (body.kind === 'tool' ? [[body.toolCallId, body.state]] : []))).toEqual([['call-G1', 'running'], ['call-G2', 'running']]);
        expect(stream(h, runId).flatMap(body => (body.kind === 'tool' ? [[body.toolCallId, body.state]] : []))).toEqual([['call-M', 'running']]);
        expect(stream(h, g1.id)).toEqual([{ kind: 'assistant', text: 'Working on 1', done: true }]);

        // Nothing is cancelled by the turn that ended meanwhile, and what the grandchildren say later is not a new sub-agent.
        await Bun.sleep(100);
        expect(natives(h, runId).map(run => run.status)).toEqual(['running', 'running', 'running']);

        finished.release();
        await waitFor(() => status() === 'succeeded', 'the run to end');
        expect(natives(h, runId)).toHaveLength(3);
        expect(natives(h, runId).map(run => run.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
        expect(notes()).toEqual(['Background sub-agent finished: Middle']);
    });

    test('a Stop of the one that started them asks for each, the ones below it too, since the agent leaves them working; the run goes on', async () => {
        const finished = latch();
        const { h, engine, runId, status } = await setup(nesting({ finished }), {}, () => true, undefined, () => true);

        await started(h, runId);

        const [m, g1, g2] = [named(h, runId, 'Middle'), named(h, runId, 'Grand 1'), named(h, runId, 'Grand 2')];
        const { cancelled } = h.ok('run.cancel', { runId: m.id });

        expect(cancelled[0]).toBe(m.id);
        expect(new Set(cancelled)).toEqual(new Set([m.id, g1.id, g2.id]));
        await waitFor(() => natives(h, runId).every(run => run.status === 'cancelled'), 'the whole branch to end');
        expect(engine.stopRequests[0]).toBe('agent-M');
        expect([...engine.stopRequests].sort()).toEqual(['agent-G1', 'agent-G2', 'agent-M']);
        expect(h.run(runId).background).toBeUndefined();
        expect(natives(h, runId)).toHaveLength(3);
        expect(h.run(runId).status).toBe('waiting_background');
        finished.release();
        await waitFor(() => status() === 'succeeded', 'the run to end');
    });

    test('a Stop of one of them ends it alone: the one that started it and its sibling go on', async () => {
        const finished = latch();
        const { h, engine, runId, status } = await setup(nesting({ finished }), {}, () => true, undefined, () => true);

        await started(h, runId);

        const [m, g1, g2] = [named(h, runId, 'Middle'), named(h, runId, 'Grand 1'), named(h, runId, 'Grand 2')];

        expect(h.ok('run.cancel', { runId: g1.id })).toEqual({ cancelled: [g1.id] });
        await waitFor(() => h.run(g1.id).status === 'cancelled', 'the grandchild to end');
        expect(engine.stopRequests).toEqual(['agent-G1']);
        expect([h.run(m.id).status, h.run(g2.id).status, h.run(runId).status]).toEqual(['running', 'running', 'waiting_background']);
        finished.release();
        await waitFor(() => status() === 'succeeded', 'the run to end');
    });

    test('Stop all asks each sub-agent once, the deepest first, and the run goes on', async () => {
        const finished = latch();
        const { h, engine, runId } = await setup(nesting({ finished }), {}, () => true, undefined, () => true);

        await started(h, runId);

        const [m, g1, g2] = [named(h, runId, 'Middle'), named(h, runId, 'Grand 1'), named(h, runId, 'Grand 2')];
        const { stopped } = h.ok('run.stopAgents', { runId });

        expect(new Set(stopped)).toEqual(new Set([m.id, g1.id, g2.id]));
        expect(stopped.at(-1)).toBe(m.id);
        await waitFor(() => natives(h, runId).every(run => run.status === 'cancelled'), 'every sub-agent to end');
        expect([...engine.stopRequests].sort()).toEqual(['agent-G1', 'agent-G2', 'agent-M']);
        expect(engine.stopRequests.at(-1)).toBe('agent-M');
        expect(h.run(runId).status).toBe('waiting_background');
        finished.release();
        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to end');
    });

    test('a Stop of the whole run cancels the three with it', async () => {
        const finished = latch();
        const { h, runId } = await setup(nesting({ finished }), {}, () => true, undefined, () => true);

        await started(h, runId);

        const { cancelled } = h.ok('run.cancel', { runId });

        expect(cancelled).toHaveLength(4);
        await waitFor(() => natives(h, runId).every(run => run.status === 'cancelled'), 'the sub-agents to end with the run');
        expect(natives(h, runId)).toHaveLength(3);
    });
});

/** The background commands of a chat's orchestrator the scripts below start: each can be stopped alone unless it says otherwise. */
const cmd = (n: number, over: Partial<BackgroundItem> = {}): BackgroundItem => ({ id: `cmd-${ n }`, kind: 'command', title: `sleep ${ n }0`, canStopAlone: true, ...over });

interface Commands {
    /** The commands the first turn starts in the background. */
    items: BackgroundItem[];
    /** Released by the test when that command ends on its own, by item id. */
    ends?: Record<string, Latch>;
    /** The agent reports the end of the last work by itself, in a turn of its own (Claude Code); without it it says nothing until it is sent a prompt (Codex). */
    reports?: boolean;
    /** The first turn goes on until the test releases this: the orchestrator's turn runs while the command is stopped, or ends. */
    turn?: Latch;
    /** Held before the `done` of the answer to a message sent into the session. */
    gate?: Latch;
    /** Each command also has the tool call that started it (its id is the item's), which ends failed with no text when the command is stopped, as a real adapter reports it. */
    cards?: boolean;
}

/**
 * An orchestrator that starts background commands and keeps its session for them. A command it is asked to stop alone ends the way a real adapter ends it: the
 * list without it, and no word to the agent. A command the test lets end leaves the list too, and the agent reports it in a turn of its own or waits to be told
 * (`reports`). Every prompt sent into the session is answered by a turn that says `Heard: <text>`, and the session ends once nothing is open and it was answered.
 */
function commandsScript(plan: Commands): Script {
    return async function* (turn) {
        yield { type: 'session', sessionId: 's-1' };

        const open = new Map(plan.items.map(item => [item.id, item]));
        const holds = new Map<string, Promise<boolean>>();
        // A real adapter names the calls that stand for the listed commands, so the end of the turn leaves them running.
        const listing = (): EngineEvent => ({ type: 'background', items: [...open.values()], ...(plan.cards && { calls: [...open.keys()] }) });

        yield { type: 'text', delta: 'Started them', done: true };

        for (const item of plan.cards ? plan.items : []) {
            yield { type: 'tool', toolCallId: item.id, name: 'Bash', input: { command: item.title }, state: 'running' };
        }
        yield listing();

        if (plan.turn && !await turn.hold(plan.turn)) {
            return;
        }

        yield { type: 'done', result: 'Started them' };

        let stop = turn.stopRequested();
        let message = turn.received();

        for (;;) {
            const ending = [...open.keys()].filter(id => plan.ends?.[id]).map(id => (holds.get(id) ?? holds.set(id, turn.hold(plan.ends![id] as Latch)).get(id) as Promise<boolean>).then(released => ({ ended: released ? id : undefined })));
            const next = await Promise.race([stop.then(stopped => ({ stopped })), message.then(text => ({ text })), ...ending]);

            if ('stopped' in next) {
                if (next.stopped === undefined) {
                    return;
                }

                open.delete(next.stopped);

                if (plan.cards) {
                    yield { type: 'tool', toolCallId: next.stopped, name: 'Bash', input: {}, state: 'error', error: 'The tool failed' };
                }

                yield listing();
                stop = turn.stopRequested();
            }
            else if ('text' in next) {
                if (next.text === undefined) {
                    return;
                }

                yield { type: 'text', delta: `Heard: ${ next.text }`, done: true };
                await plan.gate?.wait(turn.signal);
                yield { type: 'done', result: `Heard: ${ next.text }` };

                if (open.size === 0) {
                    return;
                }

                message = turn.received();
            }
            else {
                if (next.ended === undefined) {
                    return;
                }

                open.delete(next.ended);
                yield listing();

                if (open.size === 0 && plan.reports) {
                    yield { type: 'text', delta: 'It finished', done: true };
                    yield { type: 'done', result: 'It finished' };

                    return;
                }
            }
        }
    };
}

describe('stopping one background command of the work that waits', () => {
    const stopsAlone = () => true;
    const line = (title: string) => expect.stringContaining(`The user stopped the background command: ${ title }`);

    test('asks the session to end that command alone, writes that it was stopped, tells the agent, and the run and the other command go on', async () => {
        const ends = { 'cmd-2': latch() };
        const { h, engine, runId, waits, status, notes, said, history } = await setup(commandsScript({ items: [cmd(1), cmd(2)], ends, reports: true }), {}, () => true, undefined, stopsAlone);

        await waits();

        // The answer does not wait for the end: the request goes out, and the list loses the command through the snapshot the agent gives back.
        expect(h.ok('run.stopBackground', { runId, itemId: 'cmd-1' })).toEqual({ stopped: true });
        await waitFor(() => engine.sent.length === 1, 'the agent to be told');
        await waitFor(() => notes().length === 1, 'the note');

        expect(engine.stopRequests).toEqual(['cmd-1']);
        expect(engine.sent).toEqual(['The user stopped the background command: sleep 10\nIt did not finish, and no result of it will arrive. Carry on without it, and say in one short sentence what that changes for your work.']);
        expect(notes()).toEqual(['Background command stopped: sleep 10']);
        expect(h.run(runId).background).toEqual([cmd(2)]);
        // Not the person's message: nothing of it is a bubble, and the run did not leave its wait for it.
        expect(said()).toEqual(['Do the work']);
        expect(status()).toBe('waiting_background');
        expect(history()).toEqual(['queued', 'running', 'waiting_background']);

        ends['cmd-2'].release();
        await waitFor(() => status() === 'succeeded', 'the run to end');
        expect(notes()).toEqual(['Background command stopped: sleep 10', 'Background command finished: sleep 20']);
    });

    test('shows the call of a command the person stopped as stopped, not as a failure, and leaves the other command\'s call running', async () => {
        const ends = { 'cmd-2': latch() };
        const { h, runId, waits, bodies } = await setup(commandsScript({ items: [cmd(1), cmd(2)], ends, reports: true, cards: true }), {}, () => true, undefined, stopsAlone);
        const card = (id: string) => bodies().find(body => body.kind === 'tool' && body.toolCallId === id);

        await waits();
        expect(h.ok('run.stopBackground', { runId, itemId: 'cmd-1' })).toEqual({ stopped: true });
        await waitFor(() => (card('cmd-1') as { state?: string } | undefined)?.state === 'error', 'the call to end');

        expect(card('cmd-1')).toMatchObject({ state: 'error', error: STOPPED_TOOL });
        expect(card('cmd-2')).toMatchObject({ state: 'running' });
        ends['cmd-2'].release();
        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to end');
    });

    test('is not a Stop of the run: the chat is not held, and the answer to the line is a turn of its own', async () => {
        const ends = { 'cmd-1': latch() };
        const { h, engine, chat, runId, waits, bodies } = await setup(commandsScript({ items: [cmd(1), cmd(2)], ends, reports: true }), {}, () => true, undefined, stopsAlone);

        await waits();
        h.ok('run.stopBackground', { runId, itemId: 'cmd-2' });
        await waitFor(() => bodies().some(body => body.kind === 'assistant' && body.text.startsWith('Heard: The user stopped')), 'the agent to answer the line');

        expect(getChat(h.store.db, chat.id)?.queuePaused).toBeUndefined();
        expect(engine.turns).toHaveLength(1);
        expect(h.run(runId).status).toBe('waiting_background');
        ends['cmd-1'].release();
        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to end');
    });

    test('works while the orchestrator\'s own turn runs: the request goes out and the line is handed to the session', async () => {
        const gate = latch();
        const ends = { 'cmd-2': latch() };
        const { h, engine, runId, status } = await setup(commandsScript({ items: [cmd(1), cmd(2)], ends, turn: gate, reports: true }), {}, () => true, undefined, stopsAlone);

        await waitFor(() => (h.run(runId).background?.length ?? 0) === 2, 'the commands to be listed');
        expect(status()).toBe('running');
        expect(h.ok('run.stopBackground', { runId, itemId: 'cmd-1' })).toEqual({ stopped: true });
        await waitFor(() => engine.stopRequests.length === 1 && engine.sent.length === 1, 'the request and the line');
        expect(status()).toBe('running');
        gate.release();
        await waitFor(() => status() === 'waiting_background', 'the run to wait');
        ends['cmd-2'].release();
        await waitFor(() => status() === 'succeeded', 'the run to end');
    });

    test('answers false and asks nobody for a command that cannot be stopped alone, one that is not listed, a sub-agent, and a run that is over', async () => {
        const ends = { 'cmd-2': latch() };
        const { h, engine, runId, waits } = await setup(commandsScript({ items: [cmd(1), cmd(2, { canStopAlone: undefined }), { id: 'call-1', kind: 'subagent', title: 'Explore', canStopAlone: true }], ends, reports: true }), {}, () => true, undefined, stopsAlone);

        await waits();

        for (const itemId of ['cmd-2', 'nobody', 'call-1']) {
            expect(h.ok('run.stopBackground', { runId, itemId })).toEqual({ stopped: false });
        }

        await Bun.sleep(50);
        expect(engine.stopRequests).toEqual([]);
        expect(engine.sent).toEqual([]);

        h.ok('run.cancel', { runId });
        await waitFor(() => h.run(runId).status === 'cancelled', 'the run to be cancelled');
        expect(h.ok('run.stopBackground', { runId, itemId: 'cmd-1' })).toEqual({ stopped: false });
        expect(engine.stopRequests).toEqual([]);
    });

    test('answers false for a session that cannot end one command alone, which still has the Stop of the run', async () => {
        const { h, engine, runId, waits } = await setup(commandsScript({ items: [cmd(1)], reports: true }), {}, () => true);

        await waits();
        expect(h.ok('run.stopBackground', { runId, itemId: 'cmd-1' })).toEqual({ stopped: false });
        expect(engine.stopRequests).toEqual([]);
        expect(h.ok('run.cancel', { runId })).toEqual({ cancelled: [runId] });
    });

    test('the stream says a command was stopped at once, not when the agent next does something: here it is not told and says nothing', async () => {
        const ends = { 'cmd-2': latch() };
        const { h, runId, waits, notes } = await setup(commandsScript({ items: [cmd(1), cmd(2)], ends, reports: true }), {}, () => false, undefined, stopsAlone);

        await waits();
        expect(h.ok('run.stopBackground', { runId, itemId: 'cmd-1' })).toEqual({ stopped: true });
        await waitFor(() => notes().length === 1, 'the note of the stopped command');
        expect(notes()).toEqual(['Background command stopped: sleep 10']);
        expect(h.run(runId).background).toEqual([cmd(2)]);
        ends['cmd-2'].release();
        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to end');
    });

    test('a second press for the command that is being stopped is the same request: one request, one line, the same answer', async () => {
        const ends = { 'cmd-2': latch() };
        const { h, engine, runId, waits } = await setup(commandsScript({ items: [cmd(1), cmd(2)], ends, reports: true }), {}, () => true, undefined, stopsAlone);

        await waits();
        expect(h.ok('run.stopBackground', { runId, itemId: 'cmd-1' })).toEqual({ stopped: true });
        expect(h.ok('run.stopBackground', { runId, itemId: 'cmd-1' })).toEqual({ stopped: true });
        await waitFor(() => engine.sent.length === 1, 'the line');
        await Bun.sleep(50);
        expect(engine.stopRequests).toEqual(['cmd-1']);
        expect(engine.sent).toHaveLength(1);
        ends['cmd-2'].release();
        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to end');
    });

    test('a request sent again with the same request id is answered from the first one and asks nobody twice', async () => {
        const ends = { 'cmd-2': latch() };
        const { h, engine, runId, waits } = await setup(commandsScript({ items: [cmd(1), cmd(2)], ends, reports: true }), {}, () => true, undefined, stopsAlone);

        await waits();

        const stop = makeCommand('run.stopBackground', { runId, itemId: 'cmd-1' });
        const first = executeCommand(h.daemon.services, stop);

        expect(first).toMatchObject({ ok: true, data: { stopped: true } });
        expect(executeCommand(h.daemon.services, stop)).toEqual(first);
        await waitFor(() => engine.sent.length === 1, 'the line');
        await Bun.sleep(50);
        expect(engine.stopRequests).toEqual(['cmd-1']);
        expect(engine.sent).toHaveLength(1);
        ends['cmd-2'].release();
        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to end');
    });

    test('asks the agent only once the transaction has committed: a Stop that rolls back sends nothing', async () => {
        const ends = { 'cmd-1': latch() };
        const { h, engine, runId, waits } = await setup(commandsScript({ items: [cmd(1)], ends, reports: true }), {}, () => true, undefined, stopsAlone);

        await waits();

        expect(() => h.store.tx(() => {
            h.daemon.services.runs.stopBackground(runId, 'cmd-1');
            throw new Error('rolled back');
        })).toThrow('rolled back');
        await Bun.sleep(50);
        expect(engine.stopRequests).toEqual([]);
        expect(engine.sent).toEqual([]);
        expect(h.run(runId).background).toEqual([cmd(1)]);

        // Committed, it is asked once, and a rolled-back attempt did not leave the command marked as being stopped.
        expect(h.ok('run.stopBackground', { runId, itemId: 'cmd-1' })).toEqual({ stopped: true });
        await waitFor(() => engine.stopRequests.length === 1, 'the request');
        expect(engine.stopRequests).toEqual(['cmd-1']);
    });

    test('a Stop of the run right after tells the agent nothing: the session is ending', async () => {
        const { h, engine, runId, waits } = await setup(commandsScript({ items: [cmd(1)], reports: true }), {}, () => true, undefined, stopsAlone);

        await waits();
        h.ok('run.stopBackground', { runId, itemId: 'cmd-1' });
        h.ok('run.cancel', { runId });
        await waitFor(() => h.run(runId).status === 'cancelled', 'the run to be cancelled');
        await Bun.sleep(100);
        expect(engine.sent).toEqual([]);
    });

    test('a command the agent would not stop, or that ended on its own meanwhile, is no stop: nothing is told, and it is written as finished when it ends', async () => {
        const ends = { 'cmd-1': latch() };
        const { h, engine, runId, waits, notes, status } = await setup(commandsScript({ items: [cmd(1)], ends, reports: true }), {}, () => true, undefined, () => false);

        await waits();
        h.ok('run.stopBackground', { runId, itemId: 'cmd-1' });
        await waitFor(() => engine.stopRequests.length === 1, 'the request');
        await Bun.sleep(50);
        expect(engine.sent).toEqual([]);
        expect(h.run(runId).background).toEqual([cmd(1)]);

        // It can be asked again, since the first request did not take.
        h.ok('run.stopBackground', { runId, itemId: 'cmd-1' });
        await waitFor(() => engine.stopRequests.length === 2, 'the second request');
        ends['cmd-1'].release();
        await waitFor(() => status() === 'succeeded', 'the run to end');
        expect(notes()).toEqual(['Background command finished: sleep 10']);
    });
});

describe('telling an agent that starts no turn of its own that its background work ended', () => {
    const finishedLine = (title: string) => expect.stringContaining(`Background command finished: ${ title }`);

    /** A chat whose agent says it never reports finished work (`EngineSession.wakesOnBackgroundEnd`). */
    async function wakingSetup(plan: Commands, wakes = true, stops?: ScriptEngine['stopAnswer']) {
        const engine = new ScriptEngine(commandsScript(plan));

        engine.sendAnswer = () => true;
        engine.wakes = wakes;

        if (stops) {
            engine.stopAnswer = stops;
        }

        const h = await startHarness({}, { engines: scriptEngines(engine) });

        harnesses.push(h);

        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id }) as { chat: Chat };
        const runId = h.ok('chat.send', { chatId: chat.id, text: 'Do the work' }).runId as string;
        const bodies = () => listItems(h.store.db, runId, 0).map(item => item.body);
        const notes = () => bodies().flatMap(body => (body.kind === 'note' ? [body.text] : []));
        const status = () => h.run(runId).status;
        const history = (): RunStatus[] => {
            const seen: RunStatus[] = [];

            for (const event of h.events()) {
                if (event.data.type === 'run.upserted' && event.data.run.id === runId && seen.at(-1) !== event.data.run.status) {
                    seen.push(event.data.run.status);
                }
            }

            return seen;
        };

        await waitFor(() => status() === 'waiting_background', 'the run to wait for background work');

        return { h, engine, chat, runId, bodies, notes, status, history };
    }

    test('the last item leaving the list sends the agent one note, and its answer is a turn of its own that ends the run, with no message of the person in the stream', async () => {
        const ends = { 'cmd-1': latch() };
        const { h, engine, runId, bodies, notes, status, history } = await wakingSetup({ items: [cmd(1)], ends });

        expect(engine.sent).toEqual([]);
        ends['cmd-1'].release();
        await waitFor(() => status() === 'succeeded', 'the run to end');

        expect(engine.sent).toEqual(['Background command finished: sleep 10\nCheck how it went and tell the user what came of it, briefly.']);
        expect(notes()).toEqual(['Background command finished: sleep 10']);
        expect(bodies().filter(body => body.kind === 'user').map(body => body.text)).toEqual(['Do the work']);
        // The note comes before what the agent said of it, and the answer is the run's result.
        expect(bodies().flatMap(body => (body.kind === 'note' || body.kind === 'assistant' ? [body.kind] : []))).toEqual(['assistant', 'note', 'assistant']);
        expect(h.run(runId).result).toMatch(/^Heard: Background command finished: sleep 10/);
        // The run stayed in its wait through the agent's turn: no slot was taken for it.
        expect(history()).toEqual(['queued', 'running', 'waiting_background', 'succeeded']);
    });

    test('an agent that reports by itself is sent nothing: the flag is the agent\'s', async () => {
        const ends = { 'cmd-1': latch() };
        const { engine, status, notes } = await wakingSetup({ items: [cmd(1)], ends, reports: true }, false);

        ends['cmd-1'].release();
        await waitFor(() => status() === 'succeeded', 'the run to end');
        expect(engine.sent).toEqual([]);
        expect(notes()).toEqual(['Background command finished: sleep 10']);
    });

    test('only the last item to leave sends it, and its note names every item that finished since the agent last heard', async () => {
        const ends = { 'cmd-1': latch(), 'cmd-2': latch() };
        const { engine, status, notes } = await wakingSetup({ items: [cmd(1), cmd(2)], ends });

        ends['cmd-1'].release();
        await Bun.sleep(100);
        expect(engine.sent).toEqual([]);
        expect(status()).toBe('waiting_background');

        ends['cmd-2'].release();
        await waitFor(() => status() === 'succeeded', 'the run to end');
        expect(engine.sent).toEqual(['Background command finished: sleep 10\nBackground command finished: sleep 20\nCheck how they went and tell the user what came of them, briefly.']);
        expect(notes()).toEqual(['Background command finished: sleep 10', 'Background command finished: sleep 20']);
    });

    test('a sub-agent that ended is told the same way, and its child run ends with it', async () => {
        const finished = latch();
        const engine = new ScriptEngine(async function* (turn) {
            yield { type: 'session', sessionId: 's-1' };
            yield* starts(1);
            yield { type: 'background', items: [agentItem(1)] };
            yield { type: 'done', result: 'Started it' };

            const message = turn.received();

            if (!await turn.hold(finished)) {
                return;
            }

            yield { type: 'tool', toolCallId: 'call-1', name: 'Agent', input: {}, state: 'done', output: 'Done' };
            yield { type: 'subagent', agentId: 'agent-1', parentToolCallId: 'call-1', name: 'Explore', state: 'done', summary: 'Done' };
            yield { type: 'background', items: [] };

            const text = await message;

            if (text !== undefined) {
                yield { type: 'text', delta: `Heard: ${ text }`, done: true };
                yield { type: 'done', result: `Heard: ${ text }` };
            }
        });

        engine.sendAnswer = () => true;
        engine.wakes = true;

        const h = await startHarness({}, { engines: scriptEngines(engine) });

        harnesses.push(h);

        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id }) as { chat: Chat };
        const runId = h.ok('chat.send', { chatId: chat.id, text: 'Do the work' }).runId as string;

        await waitFor(() => h.run(runId).status === 'waiting_background', 'the run to wait');
        finished.release();
        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to end');

        expect(engine.sent).toEqual(['Background sub-agent finished: Explore 1\nCheck how it went and tell the user what came of it, briefly.']);
        expect(projectSnapshot(h.store, h.run(runId).projectId).runs.filter((run: Run) => run.origin === 'native').map(run => run.status)).toEqual(['succeeded']);
    });

    test('nothing is sent for a command the person stopped: the agent was told when they did, and that line is the only thing it hears', async () => {
        const { h, engine, status, notes, runId } = await wakingSetup({ items: [cmd(1)] }, true, () => true);

        h.ok('run.stopBackground', { runId, itemId: 'cmd-1' });
        await waitFor(() => status() === 'succeeded', 'the run to end');
        expect(engine.sent).toHaveLength(1);
        expect(engine.sent[0]).toMatch(/^The user stopped the background command: sleep 10/);
        expect(notes()).toEqual(['Background command stopped: sleep 10']);
    });

    test('a stopped command and one that finished are told together, and only the one that finished is in the note', async () => {
        const ends = { 'cmd-2': latch() };
        const { h, engine, status, notes, runId } = await wakingSetup({ items: [cmd(1), cmd(2)], ends }, true, () => true);

        h.ok('run.stopBackground', { runId, itemId: 'cmd-1' });
        await waitFor(() => engine.sent.length === 1, 'the line');
        ends['cmd-2'].release();
        await waitFor(() => engine.sent.length === 2, 'the note');
        await waitFor(() => status() === 'succeeded', 'the run to end');

        expect(engine.sent[1]).toMatch(/^Background command finished: sleep 20\n/);
        expect(engine.sent[1]).not.toContain('sleep 10');
        expect(notes()).toEqual(['Background command stopped: sleep 10', 'Background command finished: sleep 20']);
    });

    test('a command that finished while another was open, and the other one the person stops last: the agent hears of both, in one prompt', async () => {
        const ends = { 'cmd-2': latch() };
        const { h, engine, status, notes, runId } = await wakingSetup({ items: [cmd(1), cmd(2)], ends }, true, () => true);

        ends['cmd-2'].release();
        await waitFor(() => h.run(runId).background?.length === 1, 'the command to leave the list');
        // Nothing is told yet: one item is still open.
        expect(engine.sent).toEqual([]);
        h.ok('run.stopBackground', { runId, itemId: 'cmd-1' });
        await waitFor(() => status() === 'succeeded', 'the run to end');

        // The prompt of the stop is in flight when the list empties, which keeps the note back: the finished one is in that prompt.
        expect(engine.sent).toEqual([
            'Background command finished: sleep 20\nCheck how it went and tell the user what came of it, briefly.\n\nThe user stopped the background command: sleep 10\nIt did not finish, and no result of it will arrive. Carry on without it, and say in one short sentence what that changes for your work.',
        ]);
        expect(notes()).toEqual(['Background command finished: sleep 20', 'Background command stopped: sleep 10']);
    });

    test('nothing is sent while a message of ours is on its way: the item leaving during the answer to a message is not announced', async () => {
        const gate = latch();
        const engine = new ScriptEngine(async function* (turn) {
            yield { type: 'session', sessionId: 's-1' };
            yield { type: 'background', items: [cmd(1)] };
            yield { type: 'done', result: 'Started it' };

            const text = await turn.received();

            if (text === undefined) {
                return;
            }

            // The command ends while the agent is answering the message.
            yield { type: 'text', delta: `Heard: ${ text }`, done: true };
            yield { type: 'background', items: [] };
            await gate.wait(turn.signal);
            yield { type: 'done', result: `Heard: ${ text }` };
        });

        engine.sendAnswer = () => true;
        engine.wakes = true;

        const h = await startHarness({}, { engines: scriptEngines(engine) });

        harnesses.push(h);

        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id }) as { chat: Chat };
        const runId = h.ok('chat.send', { chatId: chat.id, text: 'Do the work' }).runId as string;

        await waitFor(() => h.run(runId).status === 'waiting_background', 'the run to wait');
        h.ok('chat.send', { chatId: chat.id, text: 'Meanwhile' });
        await waitFor(() => h.run(runId).background === undefined, 'the list to be empty');
        await Bun.sleep(100);
        expect(engine.sent).toEqual(['Meanwhile']);
        gate.release();
        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to end');
        expect(engine.sent).toEqual(['Meanwhile']);
    });

    test('nothing is sent while the agent answers the line about a stopped command: the last item leaving then is not announced either', async () => {
        const gate = latch();
        const engine = new ScriptEngine(async function* (turn) {
            yield { type: 'session', sessionId: 's-1' };
            yield { type: 'background', items: [cmd(1), cmd(2)] };
            yield { type: 'done', result: 'Started them' };

            if (await turn.stopRequested() === undefined) {
                return;
            }

            yield { type: 'background', items: [cmd(2)] };

            const text = await turn.received();

            if (text === undefined) {
                return;
            }

            // The other command ends while the agent is answering what it was told of the first.
            yield { type: 'text', delta: `Heard: ${ text }`, done: true };
            yield { type: 'background', items: [] };
            await gate.wait(turn.signal);
            yield { type: 'done', result: `Heard: ${ text }` };
        });

        engine.sendAnswer = () => true;
        engine.stopAnswer = () => true;
        engine.wakes = true;

        const h = await startHarness({}, { engines: scriptEngines(engine) });

        harnesses.push(h);

        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id }) as { chat: Chat };
        const runId = h.ok('chat.send', { chatId: chat.id, text: 'Do the work' }).runId as string;

        await waitFor(() => h.run(runId).status === 'waiting_background', 'the run to wait');
        h.ok('run.stopBackground', { runId, itemId: 'cmd-1' });
        await waitFor(() => h.run(runId).background === undefined, 'the list to be empty');
        await Bun.sleep(100);
        expect(engine.sent).toHaveLength(1);
        gate.release();
        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to end');
        expect(engine.sent).toHaveLength(1);
    });

    test('an item that ended while the first turn still ran is not announced: the agent was there when it did', async () => {
        const gate = latch();
        const engine = new ScriptEngine(async function* (turn) {
            yield { type: 'session', sessionId: 's-1' };
            yield { type: 'background', items: [cmd(1)] };
            yield { type: 'background', items: [] };

            if (!await turn.hold(gate)) {
                return;
            }

            yield { type: 'text', delta: 'Done', done: true };
            yield { type: 'done', result: 'Done' };
        });

        engine.sendAnswer = () => true;
        engine.wakes = true;

        const h = await startHarness({}, { engines: scriptEngines(engine) });

        harnesses.push(h);

        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id }) as { chat: Chat };
        const runId = h.ok('chat.send', { chatId: chat.id, text: 'Do the work' }).runId as string;

        await Bun.sleep(100);
        gate.release();
        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to end');
        expect(engine.sent).toEqual([]);
    });
});
