import { Database } from 'bun:sqlite';
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { getRunWork } from '../src/db/runs';
import { processesBelow, spawnInOwnGroup } from '../src/engine/process';
import { isAlive, killSurvivor, mayBeSameProcess, startTimeOf } from '../src/runs/processes';
import {
    cleanTempDirs,
    restartHarness,
    ScriptEngine,
    SHORT_TIMINGS,
    scriptEngines,
    startHarness,
    tempDir,
    untilAborted,
    waitFor,
} from './helpers';

import type { Harness } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];
const leftovers: number[] = [];

test('distinguishes a reused pid from a recorded agent and fails closed when the start time is unknown', () => {
    const started = startTimeOf(process.pid);
    expect(mayBeSameProcess({ pid: process.pid })).toBe(true);
    if (started !== undefined) {
        expect(mayBeSameProcess({ pid: process.pid, startedAt: started })).toBe(true);
        expect(mayBeSameProcess({ pid: process.pid, startedAt: started - 60_000 })).toBe(false);
    }
});

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));

    for (const pid of leftovers.splice(0)) {
        try {
            process.kill(-pid, 'SIGKILL');
        } catch {
            // already gone
        }
    }
});

/** A process in a group of its own, like an engine's process, that the test kills if the daemon does not. */
function startProcess(command: string): number {
    const child = spawn('sh', ['-c', command], { detached: true, stdio: 'ignore' });

    child.unref();
    leftovers.push(child.pid!);

    return child.pid!;
}

const gone = (pid: number) => !isAlive(pid);

describe('cancelling a run whose engine does not stop', () => {
    test('signals the process group after the grace period: SIGTERM first, SIGKILL for what ignores it', async () => {
        const polite = startProcess('sleep 60');
        const stubborn = startProcess('trap "" TERM; while true; do sleep 1; done');
        const pids = [polite, stubborn];
        const engine = new ScriptEngine(async function* ({ number, options }) {
            yield { type: 'session', sessionId: `s${number}` };

            const pid = pids[number - 1];

            yield { type: 'process', pid, pgid: pid };

            // The engine never notices the abort.
            await new Promise(() => undefined);
            yield { type: 'done', result: String(options.prompt.length) };
        });
        const h = await startHarness(
            { timings: { ...SHORT_TIMINGS, killGraceMs: 300 } },
            { engines: scriptEngines(engine) }
        );

        harnesses.push(h);

        const project = h.openRepo();
        const runs = ['A', 'B'].map(
            title =>
                h.ok('task.start', { taskId: h.ok('task.create', { projectId: project.id, title }).task.id })
                    .runId as string
        );

        await waitFor(() => runs.every(id => getRunWork(h.store.db, id).process), 'both processes to be recorded');

        const recorded = getRunWork(h.store.db, runs[0]).process!;

        expect(recorded).toMatchObject({ pid: polite, pgid: polite });
        expect(Math.abs(recorded.startedAt! - startTimeOf(polite)!)).toBeLessThan(2000);

        const cancelledAt = Date.now();

        for (const id of runs) {
            h.ok('run.cancel', { runId: id });
        }

        // Nothing is signalled before the grace period is over.
        await Bun.sleep(150);
        expect(pids.every(isAlive)).toBe(true);

        await waitFor(() => gone(polite), 'SIGTERM to end the polite process', 3000);
        expect(Date.now() - cancelledAt).toBeGreaterThanOrEqual(300);
        expect(isAlive(stubborn)).toBe(true);
        await waitFor(() => gone(stubborn), 'SIGKILL to end the one that ignores SIGTERM', 3000);
        expect(Date.now() - cancelledAt).toBeGreaterThanOrEqual(600);
    });

    test('a run that stops by itself is left alone, and its process record is cleared', async () => {
        const pid = startProcess('sleep 60');
        const engine = new ScriptEngine(async function* ({ signal }) {
            yield { type: 'session', sessionId: 's1' };
            yield { type: 'process', pid, pgid: pid };
            await untilAborted(signal);
        });
        const h = await startHarness(
            { timings: { ...SHORT_TIMINGS, killGraceMs: 200 } },
            { engines: scriptEngines(engine) }
        );

        harnesses.push(h);

        const project = h.openRepo();
        const runId = h.ok('task.start', { taskId: h.ok('task.create', { projectId: project.id, title: 'A' }).task.id })
            .runId as string;

        await waitFor(() => getRunWork(h.store.db, runId).process, 'the process to be recorded');
        h.ok('run.cancel', { runId });
        await waitFor(() => !getRunWork(h.store.db, runId).process, 'the record to be cleared');
        await Bun.sleep(600);
        expect(isAlive(pid)).toBe(true);
    });
});

describe('a daemon that crashed', () => {
    test('kills engine processes that outlived it, but only those that are still the recorded process, and interrupts their runs', async () => {
        const engine = new ScriptEngine(async function* ({ signal }) {
            yield { type: 'session', sessionId: 's1' };
            await untilAborted(signal);
        });
        const first = await startHarness({}, { engines: scriptEngines(engine) });
        const project = first.openRepo();
        const runs = ['A', 'B'].map(
            title =>
                first.ok('task.start', { taskId: first.ok('task.create', { projectId: project.id, title }).task.id })
                    .runId as string
        );

        await waitFor(
            () => engine.turns.length === 2 && runs.every(id => first.run(id).status === 'running'),
            'two live runs'
        );
        await first.stop();

        // What a crash leaves behind: runs still `running`, their engine processes still alive.
        const survivor = startProcess('sleep 60');
        const recycled = startProcess('sleep 60');
        const db = new Database(join(first.config.dataDir, 'clowdy.db'));
        const record = db.query(
            "UPDATE runs SET pid = ?, pgid = ?, process_started_at = ?, status = 'running' WHERE id = ?"
        );

        // `recycled` stands for a pid the OS gave to another process after the engine died: it started long after the recorded time.
        record.run(survivor, survivor, startTimeOf(survivor)!, runs[0]);
        record.run(recycled, recycled, startTimeOf(recycled)! - 3_600_000, runs[1]);
        db.close();

        const after = new ScriptEngine(async function* () {
            yield { type: 'done' };
        });
        const second = await restartHarness(first, { engines: scriptEngines(after) });

        harnesses.push(second);
        await Bun.sleep(50);
        expect(after.turns).toHaveLength(0);
        expect(isAlive(survivor)).toBe(false);
        expect(isAlive(recycled)).toBe(true);
        expect(runs.map(id => second.run(id))).toEqual([
            expect.objectContaining({ status: 'interrupted', statusReason: 'Daemon restarted' }),
            expect.objectContaining({ status: 'interrupted', statusReason: 'Daemon restarted' }),
        ]);
        expect(runs.map(id => getRunWork(second.store.db, id).process)).toEqual([undefined, undefined]);
    });
});

describe('the process guard', () => {
    test('refuses to start an engine session beyond the cap on live processes', async () => {
        const engine = new ScriptEngine(async function* ({ signal }) {
            yield { type: 'session', sessionId: 's1' };
            await untilAborted(signal);
        });
        const h = await startHarness({ maxProcesses: 2 }, { engines: scriptEngines(engine) });

        harnesses.push(h);

        const project = h.openRepo();
        const runs = ['A', 'B', 'C'].map(
            title =>
                h.ok('task.start', { taskId: h.ok('task.create', { projectId: project.id, title }).task.id })
                    .runId as string
        );

        await waitFor(() => h.run(runs[2]).status === 'failed', 'the third run to be refused');
        expect(h.run(runs[2]).error).toBe(
            '2 engine processes are alive, the most this daemon allows (CLOWDY_MAX_PROCESSES); the run was not started'
        );
        expect(runs.slice(0, 2).map(id => h.run(id).status)).toEqual(['running', 'running']);
        expect(engine.turns).toHaveLength(2);
    });

    test('a run whose slot came free while the previous session still shuts down waits for it instead of being refused', async () => {
        const engine = new ScriptEngine(async function* () {
            yield { type: 'session', sessionId: 's1' };
            yield { type: 'done', result: 'ok' };
        }, 100);
        const h = await startHarness({ maxProcesses: 1, maxRuns: 1 }, { engines: scriptEngines(engine) });

        harnesses.push(h);

        const project = h.openRepo();
        const runs = ['A', 'B', 'C'].map(
            title =>
                h.ok('task.start', { taskId: h.ok('task.create', { projectId: project.id, title }).task.id })
                    .runId as string
        );

        await waitFor(() => runs.every(id => h.run(id).status === 'succeeded'), 'every run to finish');
        expect(engine.turns).toHaveLength(3);
    });
});

/**
 * An agent as Claude Code's adapter is to the daemon: it starts a shell command in a group of its own (the command is the agent's child but not in its
 * group, and outlives it) and says the command's pid on stdout.
 */
const AGENT_WITH_DETACHED_TOOL = `
const tool = require('node:child_process').spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });

tool.unref();
console.log('tool ' + tool.pid);
setInterval(() => undefined, 1000);
`;

/** The same agent, but it ignores SIGTERM, and its tool leaves on SIGTERM (a program that cleans up): SIGTERM has to reach the tool before the agent is killed. */
const STUBBORN_AGENT_WITH_DETACHED_TOOL = `
const tool = require('node:child_process').spawn('sh', ['-c', 'trap "exit 0" TERM; while :; do sleep 0.2; done'], { detached: true, stdio: 'ignore' });

process.on('SIGTERM', () => undefined);
tool.unref();
console.log('tool ' + tool.pid);
setInterval(() => undefined, 1000);
`;

/** The pid a process that runs `AGENT_WITH_DETACHED_TOOL` says its tool has. */
function toolOf(child: { stdout: NodeJS.ReadableStream | null }): Promise<number> {
    return new Promise(resolve => {
        child.stdout?.on('data', (data: Buffer) => {
            const match = /tool (\d+)/.exec(String(data));

            if (match) {
                resolve(Number(match[1]));
            }
        });
    });
}

describe("a tool that left the agent's process group", () => {
    const tools: number[] = [];

    afterEach(() => {
        for (const pid of tools.splice(0)) {
            try {
                process.kill(-pid, 'SIGKILL');
            } catch {
                // already gone
            }
        }
    });

    async function startAgent(script = AGENT_WITH_DETACHED_TOOL) {
        const agent = await spawnInOwnGroup({
            command: process.execPath,
            args: ['-e', script],
            cwd: tempDir(),
            env: { PATH: process.env.PATH ?? '' },
        });
        leftovers.push(agent.pid);

        const tool = await toolOf(agent.child);

        tools.push(tool);
        // The tool is below the agent and in a group of its own: the agent's group does not reach it.
        expect(isAlive(tool)).toBe(true);
        expect(tool).not.toBe(agent.pid);

        return { agent, tool };
    }

    test('goes down with a stop of the agent', async () => {
        const { agent, tool } = await startAgent();

        agent.stop();
        await agent.exited;
        await waitFor(() => gone(tool), 'the tool to be stopped');
    });

    test('is asked to stop (SIGTERM) when the agent is, before the agent is killed for ignoring it', async () => {
        const { agent, tool } = await startAgent(STUBBORN_AGENT_WITH_DETACHED_TOOL);

        agent.stop();
        await waitFor(() => gone(tool), 'the tool to leave on SIGTERM');
        // The agent shrugs SIGTERM off: it is still there, and the tool was not killed with it.
        expect(isAlive(agent.pid)).toBe(true);
        await agent.exited;
    });

    test("goes down when the agent leaves by itself after a cancel began, which is how Claude Code's adapter leaves when its input closes", async () => {
        const { agent, tool } = await startAgent();

        agent.watch();
        // Only the agent: its own group is signalled when it is gone, and the tool is not in it.
        agent.child.kill('SIGKILL');
        await agent.exited;
        await waitFor(() => gone(tool), 'the tool to be stopped');
    });

    test('is left alone while the agent works: nothing is signalled before a stop', async () => {
        const { agent, tool } = await startAgent();

        agent.watch();
        await Bun.sleep(300);
        expect(isAlive(tool)).toBe(true);
        agent.stop();
        await agent.exited;
    });

    test('is found below the agent with its own group, and nothing else is: not the agent, this process, nor the one that started it', async () => {
        const { agent, tool } = await startAgent();
        const found = processesBelow(agent.pid);

        expect(found).toContainEqual({ pid: tool, pgid: tool });
        expect(found.map(({ pid }) => pid)).not.toContain(agent.pid);
        expect(found.map(({ pid }) => pid)).not.toContain(process.pid);
        expect(found.map(({ pid }) => pid)).not.toContain(process.ppid);
        expect(processesBelow(1)).toEqual([]);
        agent.stop();
        await agent.exited;
    });

    test('is not looked for where the OS cannot list processes: the agent is stopped as before, and nothing throws or waits', async () => {
        const { agent } = await startAgent();
        const path = process.env.PATH;

        // No `ps` to run (a stripped system, a failing listing): what `watch` and `stop` find is nothing.
        process.env.PATH = '/nonexistent';

        try {
            expect(processesBelow(agent.pid)).toEqual([]);
            agent.watch();
            agent.stop();
        } finally {
            process.env.PATH = path;
        }

        await agent.exited;
    });

    test('goes down with a survivor of a daemon that was killed, which startup recovery finds by the pid it recorded', async () => {
        const child = spawn(process.execPath, ['-e', AGENT_WITH_DETACHED_TOOL], {
            detached: true,
            stdio: ['ignore', 'pipe', 'ignore'],
        });

        child.unref();
        leftovers.push(child.pid!);

        const tool = await toolOf(child);

        tools.push(tool);
        expect(isAlive(tool)).toBe(true);

        // The agent started a moment ago, as the daemon recorded it before it died.
        expect(await killSurvivor({ pid: child.pid!, pgid: child.pid!, startedAt: startTimeOf(child.pid!) }, 300)).toBe(
            true
        );
        await waitFor(() => gone(child.pid!) && gone(tool), 'the agent and its tool to be stopped');
    });
});
