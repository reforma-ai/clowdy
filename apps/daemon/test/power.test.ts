import { afterAll, afterEach, expect, test } from 'bun:test';
import { ROUTES } from '@clowdy/protocol';

import { PowerService } from '../src/power';
import { cleanTempDirs, GateEngine, gateEngines, restartHarness, startHarness, tempDir, waitFor } from './helpers';

import type { SleepMode } from '@clowdy/protocol';
import type { Harness } from './helpers';

afterAll(cleanTempDirs);
const harnesses: Harness[] = [];
afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop()));
});

async function setup() {
    let awake = false;
    const sleepBlocker = {
        setAwake(value: boolean) {
            awake = value;
        },
    };
    const gate = new GateEngine();
    const h = await startHarness({}, { sleepBlocker, engines: gateEngines(gate) });
    harnesses.push(h);
    const start = (title: string) => {
        const project = h.openRepo(title);
        const task = h.ok('task.create', { projectId: project.id, title }).task;
        return h.ok('task.start', { taskId: task.id }).runId as string;
    };
    return { h, gate, start, awake: () => awake, sleepBlocker };
}

async function setMode(h: Harness, sleepMode: SleepMode) {
    const res = await h.fetch(ROUTES.power, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sleepMode }),
    });
    expect(res.ok).toBe(true);
    return res.json();
}

test('the default holds sleep only while there is unfinished work across projects', async () => {
    const { h, gate, start, awake } = await setup();
    expect(await (await h.fetch(ROUTES.power)).json()).toEqual({ sleepMode: 'while-working' });
    expect(awake()).toBe(false);
    const first = start('First project');
    const second = start('Second project');
    await waitFor(() => gate.started.length === 2, 'both agents to start');
    expect(awake()).toBe(true);
    gate.release('First project');
    await waitFor(() => h.run(first).status === 'succeeded', 'first agent to finish');
    expect(awake()).toBe(true);
    gate.release('Second project');
    await waitFor(() => h.run(second).status === 'succeeded', 'last agent to finish');
    expect(awake()).toBe(false);
});

test('allow and always take effect immediately, even during a run', async () => {
    const { h, gate, start, awake } = await setup();
    await setMode(h, 'always');
    expect(awake()).toBe(true);
    const run = start('Working');
    await waitFor(() => gate.isStarted('Working'), 'agent to start');
    await setMode(h, 'allow');
    expect(awake()).toBe(false);
    await setMode(h, 'while-working');
    expect(awake()).toBe(true);
    await setMode(h, 'always');
    gate.release('Working');
    await waitFor(() => h.run(run).status === 'succeeded', 'agent to finish');
    expect(awake()).toBe(true);
    await h.stop();
    expect(awake()).toBe(false);
});

test('settings survive daemon restarts and invalid writes cannot change them', async () => {
    const { h, awake, sleepBlocker } = await setup();
    await setMode(h, 'always');
    await h.stop();
    const restarted = await restartHarness(h, { sleepBlocker });
    harnesses.push(restarted);
    expect(await (await restarted.fetch(ROUTES.power)).json()).toEqual({ sleepMode: 'always' });
    expect(awake()).toBe(true);
    const invalid = await restarted.fetch(ROUTES.power, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sleepMode: 'invalid' }),
    });
    expect(invalid.ok).toBe(false);
    expect(await (await restarted.fetch(ROUTES.power)).json()).toEqual({ sleepMode: 'always' });
});

test('changing power settings requires daemon authorization', async () => {
    const { h, awake } = await setup();
    const response = await fetch(`${h.url}${ROUTES.power}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sleepMode: 'always' }),
    });

    expect(response.status).toBe(401);
    expect(await (await h.fetch(ROUTES.power)).json()).toEqual({ sleepMode: 'while-working' });
    expect(awake()).toBe(false);
});

test('a setting saved after shutdown takes effect only on the next start', () => {
    let awake = false;
    const power = new PowerService(tempDir(), () => false, {
        setAwake(value) {
            awake = value;
        },
    });

    power.start();
    power.stop();
    power.setMode('always');
    expect(awake).toBe(false);

    try {
        power.start();
        expect(awake).toBe(true);
    } finally {
        power.stop();
    }
});
