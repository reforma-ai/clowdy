import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { getChat } from '../src/db/chats';
import { getRun, upsertRun } from '../src/db/runs';
import { projectSnapshot } from '../src/domain/snapshots';
import { cleanTempDirs, latch, restartHarness, ScriptEngine, scriptEngines, startHarness, waitFor } from './helpers';

import type { Run } from '@clowdy/protocol';
import type { Harness } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

/**
 * One orchestrator that waits at a gate, with these sub-agents under it:
 * `plan` (done) > `explore` (done) > `grep` (done); `slow` (working); `starter` (done) > `late` (working).
 */
async function setup() {
    const gate = latch();
    const engine = new ScriptEngine(async function* ({ signal }) {
        yield { type: 'session', sessionId: 's1' };
        yield { type: 'subagent', agentId: 'a1', name: 'Plan', state: 'running' };
        yield { type: 'subagent', agentId: 'a2', parentAgentId: 'a1', name: 'Explore', state: 'running' };
        yield { type: 'subagent', agentId: 'a3', parentAgentId: 'a2', name: 'Grep', state: 'running' };
        yield { type: 'text', delta: 'Found it.', done: true, agentId: 'a3' };
        yield { type: 'subagent', agentId: 'a3', name: 'Grep', state: 'done', summary: 'Found it' };
        yield { type: 'subagent', agentId: 'a2', name: 'Explore', state: 'done', summary: 'Explored' };
        yield { type: 'subagent', agentId: 'a1', name: 'Plan', state: 'done', summary: 'Planned' };
        yield { type: 'subagent', agentId: 'a4', name: 'Slow', state: 'running' };
        yield { type: 'subagent', agentId: 'a5', name: 'Starter', state: 'running' };
        yield { type: 'subagent', agentId: 'a6', parentAgentId: 'a5', name: 'Late', state: 'running' };
        yield { type: 'subagent', agentId: 'a5', name: 'Starter', state: 'done', summary: 'Started one' };
        await gate.wait(signal);
        yield { type: 'done', result: 'Done.' };
    });
    const h = await startHarness({}, { engines: scriptEngines(engine) });

    harnesses.push(h);

    const project = h.openRepo();
    const { chat } = h.ok('chat.create', { projectId: project.id });
    const runId = h.ok('chat.send', { chatId: chat.id, text: 'Look into it' }).runId as string;
    const natives = (): Run[] => projectSnapshot(h.store, project.id).runs.filter(run => run.origin === 'native');

    await waitFor(() => natives().length === 6, 'six sub-agents');
    await waitFor(() => natives().filter(run => run.status === 'succeeded').length === 4, 'four of them to be done');

    const byName = (name: string): Run => natives().find(run => run.name === name) as Run;

    return { h, gate, project, chat, runId, natives, byName };
}

const types = (h: Harness, cursor: number) =>
    h.events(cursor).map(event => `${(event.data as { type: string }).type}:${(event.data as { run?: Run }).run?.id}`);

describe('run.setArchived', () => {
    test('archives a finished sub-agent with the sub-agents it started, announcing each run once, and moves no chat', async () => {
        const { h, project, chat, byName } = await setup();
        const [plan, explore, grep] = ['Plan', 'Explore', 'Grep'].map(byName);
        const before = getChat(h.store.db, chat.id);
        const cursor = h.store.headCursor();
        const { run } = h.ok('run.setArchived', { runId: plan.id, archived: true }) as { run: Run };

        expect(run).toMatchObject({ id: plan.id, status: 'succeeded' });
        expect(run.archivedAt).toBeGreaterThan(0);

        // The one it started and the one that one started went along, with the same time, and only they.
        for (const id of [plan.id, explore.id, grep.id]) {
            expect(h.run(id).archivedAt).toBe(run.archivedAt);
        }

        expect(['Slow', 'Starter', 'Late'].map(name => byName(name).archivedAt)).toEqual([
            undefined,
            undefined,
            undefined,
        ]);
        expect(projectSnapshot(h.store, project.id).runs.find(entry => entry.id === grep.id)?.archivedAt).toBe(
            run.archivedAt
        );
        expect(types(h, cursor)).toEqual([
            `run.upserted:${plan.id}`,
            `run.upserted:${explore.id}`,
            `run.upserted:${grep.id}`,
        ]);
        // It is not activity: the chat stays what it was, in its place in the order.
        expect(getChat(h.store.db, chat.id)).toEqual(before);
    });

    test('brings back only the named sub-agent, and says nothing for what is set already', async () => {
        const { h, byName } = await setup();
        const [plan, explore, grep] = ['Plan', 'Explore', 'Grep'].map(byName);

        h.ok('run.setArchived', { runId: plan.id, archived: true });

        const cursor = h.store.headCursor();
        const { run } = h.ok('run.setArchived', { runId: plan.id, archived: false }) as { run: Run };

        expect(run).not.toHaveProperty('archivedAt');
        expect(h.run(plan.id)).not.toHaveProperty('archivedAt');
        // What it started stays away.
        expect(h.run(explore.id).archivedAt).toBeGreaterThan(0);
        expect(h.run(grep.id).archivedAt).toBeGreaterThan(0);
        expect(types(h, cursor)).toEqual([`run.upserted:${plan.id}`]);

        const quiet = h.store.headCursor();

        h.ok('run.setArchived', { runId: plan.id, archived: false });
        h.ok('run.setArchived', { runId: explore.id, archived: true });
        h.ok('run.setArchived', { runId: explore.id, archived: true });
        h.ok('run.setArchived', { runId: byName('Slow').id, archived: false });

        expect(h.events(quiet)).toHaveLength(0);
    });

    test('keeps the time of a sub-agent that was away already and says nothing for it, and brings back a started one while its starter stays away', async () => {
        const { h, byName } = await setup();
        const [plan, explore, grep] = ['Plan', 'Explore', 'Grep'].map(byName);

        h.ok('run.setArchived', { runId: grep.id, archived: true });

        const earlier = h.run(grep.id).archivedAt as number;
        const cursor = h.store.headCursor();
        const { run } = h.ok('run.setArchived', { runId: plan.id, archived: true }) as { run: Run };

        expect(h.run(grep.id).archivedAt).toBe(earlier);
        expect(h.run(explore.id).archivedAt).toBe(run.archivedAt);
        expect(types(h, cursor)).toEqual([`run.upserted:${plan.id}`, `run.upserted:${explore.id}`]);

        h.ok('run.setArchived', { runId: explore.id, archived: false });
        expect(h.run(explore.id)).not.toHaveProperty('archivedAt');
        expect(h.run(plan.id).archivedAt).toBe(run.archivedAt);
        expect(h.run(grep.id).archivedAt).toBe(earlier);
    });

    test('keeps the run, its stream and its place in the snapshot', async () => {
        const { h, project, byName } = await setup();
        const grep = byName('Grep');
        const streamOf = () =>
            h.store.db.query('SELECT id, seq, body FROM stream_items WHERE run_id = ? ORDER BY seq').all(grep.id);
        const before = streamOf();
        const ids = projectSnapshot(h.store, project.id).runs.map(run => run.id);

        h.ok('run.setArchived', { runId: byName('Plan').id, archived: true });

        expect(before.length).toBeGreaterThan(0);
        expect(streamOf()).toEqual(before);
        expect(projectSnapshot(h.store, project.id).runs.map(run => run.id)).toEqual(ids);

        // The reads clients use still answer: the stream of the archived sub-agent, and the snapshot with the flag on it.
        const items = (await (await h.fetch(`/v1/runs/${grep.id}/items`)).json()) as unknown[];
        const snapshot = (await (await h.fetch(`/v1/projects/${project.id}/snapshot`)).json()) as { runs: Run[] };

        expect(items).toHaveLength(before.length);
        expect(snapshot.runs.find(run => run.id === grep.id)?.archivedAt).toBeGreaterThan(0);
    });

    test('refuses a sub-agent that works, and one that started a sub-agent that works', async () => {
        const { h, byName } = await setup();
        const cursor = h.store.headCursor();

        expect(h.send('run.setArchived', { runId: byName('Slow').id, archived: true })).toMatchObject({
            ok: false,
            error: { code: 'conflict', message: 'A working sub-agent cannot be archived' },
        });
        expect(h.send('run.setArchived', { runId: byName('Starter').id, archived: true })).toMatchObject({
            ok: false,
            error: { code: 'conflict' },
        });
        expect(h.events(cursor)).toHaveLength(0);
        expect(h.run(byName('Slow').id)).not.toHaveProperty('archivedAt');
        expect(h.run(byName('Starter').id)).not.toHaveProperty('archivedAt');
        expect(h.run(byName('Late').id)).not.toHaveProperty('archivedAt');
    });

    test('refuses a run that is not a sub-agent, and one that does not exist', async () => {
        const { h, runId } = await setup();

        expect(h.send('run.setArchived', { runId, archived: true })).toMatchObject({
            ok: false,
            error: { code: 'invalid' },
        });
        expect(h.send('run.setArchived', { runId: 'run_nope', archived: true })).toMatchObject({
            ok: false,
            error: { code: 'not_found' },
        });
        expect(h.run(runId)).not.toHaveProperty('archivedAt');
    });

    test('keeps the flag over a save from an older copy and a later description, and a started sub-agent that ended is put away once the orchestrator is done', async () => {
        const { h, gate, runId, byName } = await setup();
        const plan = byName('Plan');
        // A copy of the run from before it was archived, as code that saves a run it held for a while has.
        const stale = h.run(plan.id);

        h.ok('run.setArchived', { runId: plan.id, archived: true });

        const archivedAt = h.run(plan.id).archivedAt;

        upsertRun(h.store.db, { ...stale, summary: 'Written from an older copy' });
        expect(getRun(h.store.db, plan.id)).toMatchObject({ summary: 'Written from an older copy', archivedAt });

        h.daemon.services.runs.describe(plan.id, 'Described later');
        expect(h.run(plan.id)).toMatchObject({ summary: 'Described later', archivedAt });

        // The turn ends and the sub-agents still working end with it.
        gate.release();
        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to finish');
        await waitFor(() => byName('Slow').status !== 'running', 'the working sub-agent to end');
        expect(h.run(plan.id).archivedAt).toBe(archivedAt);
        expect(h.run(byName('Grep').id).archivedAt).toBe(archivedAt);

        // Over, so the one that started a sub-agent that worked can be put away too.
        const { run } = h.ok('run.setArchived', { runId: byName('Starter').id, archived: true }) as { run: Run };

        expect(h.run(byName('Late').id).archivedAt).toBe(run.archivedAt);
    });

    test('is kept over a restart', async () => {
        const { h, gate, project, runId, byName } = await setup();
        const plan = byName('Plan');

        h.ok('run.setArchived', { runId: plan.id, archived: true });
        h.ok('run.setArchived', { runId: byName('Grep').id, archived: false });
        gate.release();
        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to finish');
        await waitFor(() => byName('Slow').status !== 'running', 'the working sub-agent to end');

        const archivedAt = h.run(plan.id).archivedAt as number;

        await h.stop();

        const again = await restartHarness(h, { engines: scriptEngines(new ScriptEngine(async function* () {})) });

        harnesses.push(again);

        const runs = projectSnapshot(again.store, project.id).runs;
        const flag = (name: string) => runs.find(run => run.name === name)?.archivedAt;

        expect([flag('Plan'), flag('Explore'), flag('Grep'), flag('Slow'), flag('Starter')]).toEqual([
            archivedAt,
            archivedAt,
            undefined,
            undefined,
            undefined,
        ]);
    });
});
