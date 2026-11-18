import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { backoffDelay, EngineLimits, parseLimit } from '../src/runs/limits';
import { CONTINUE_MESSAGE } from '../src/runs/prompts';
import { cleanTempDirs, latch, restartHarness, ScriptEngine, scriptEngines, SHORT_TIMINGS, startHarness, testConfig, untilAborted, waitFor } from './helpers';

import type { EngineId } from '@clowdy/protocol';
import type { Harness, Script } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

const MINUTE = 60_000;

/** Limits on a clock the test moves. */
function clocked(options: { store?: ConstructorParameters<typeof EngineLimits>[1] extends infer O ? (O extends { store?: infer S } ? S : never) : never } = {}) {
    let now = 1_800_000_000_000;
    const limits = new EngineLimits({ claude: 6, codex: 4, fake: 100 }, { ...options, clock: () => now, random: () => 0.5, jitterMs: 30_000 });

    return { limits, advance: (ms: number) => void (now += ms), now: () => now };
}

describe('engine limits', () => {
    test('a warning halves the cap for ten minutes; more warnings only extend that', () => {
        const { limits, advance } = clocked();

        expect(limits.capOf('claude')).toBe(6);
        limits.warn('claude');
        expect(limits.capOf('claude')).toBe(3);
        expect(limits.capOf('codex')).toBe(4);
        advance(5 * MINUTE);
        limits.warn('claude');
        expect(limits.capOf('claude')).toBe(3);
        advance(9 * MINUTE);
        expect(limits.capOf('claude')).toBe(3);
        advance(MINUTE + 1);
        expect(limits.capOf('claude')).toBe(6);
    });

    test('a transient failure takes one off the cap, never below one, and each quiet five minutes gives one back', () => {
        const { limits, advance } = clocked();

        limits.transientFailure('codex');
        limits.transientFailure('codex');
        expect(limits.capOf('codex')).toBe(2);
        advance(5 * MINUTE - 1);
        expect(limits.capOf('codex')).toBe(2);
        advance(1);
        expect(limits.capOf('codex')).toBe(3);

        // Another failure starts the quiet time again.
        limits.transientFailure('codex');
        expect(limits.capOf('codex')).toBe(2);
        advance(4 * MINUTE);
        expect(limits.capOf('codex')).toBe(2);
        advance(MINUTE);
        expect(limits.capOf('codex')).toBe(3);
        advance(5 * MINUTE);
        expect(limits.capOf('codex')).toBe(4);
        advance(60 * MINUTE);
        expect(limits.capOf('codex')).toBe(4);

        for (let index = 0; index < 10; index++) {
            limits.transientFailure('codex');
        }

        expect(limits.capOf('codex')).toBe(1);
    });

    test('a warning and failures together: the lower cap wins', () => {
        const { limits } = clocked();

        limits.warn('claude');
        limits.transientFailure('claude');
        limits.transientFailure('claude');
        expect(limits.capOf('claude')).toBe(3);
        limits.transientFailure('claude');
        limits.transientFailure('claude');
        expect(limits.capOf('claude')).toBe(2);
    });

    test('a rejection pauses the engine until the reset plus jitter, and the pause is remembered', () => {
        const saved: [string, number | undefined][] = [];
        const store = { pauses: [], save: (engine: EngineId, until: number | undefined) => void saved.push([engine, until]) };
        const { limits, advance, now } = clocked({ store });
        const resetsAt = now() + 2 * 60 * MINUTE;
        const until = limits.pause('claude', resetsAt);

        expect(until).toBe(resetsAt + 15_000);
        expect(limits.pausedUntil('claude')).toBe(until);
        expect(limits.pausedUntil('codex')).toBeUndefined();
        expect(saved).toEqual([['claude', until]]);

        // A later, shorter report does not shorten the pause.
        expect(limits.pause('claude', now() + MINUTE)).toBe(until);

        advance(2 * 60 * MINUTE + 15_001);
        expect(limits.pausedUntil('claude')).toBeUndefined();
        expect(saved.at(-1)).toEqual(['claude', undefined]);

        // After a restart the pause is back.
        const restarted = new EngineLimits({ claude: 6, codex: 4, fake: 100 }, { store: { pauses: [{ engine: 'claude', until: now() + MINUTE }], save: () => undefined }, clock: now });

        expect(restarted.pausedUntil('claude')).toBe(now() + MINUTE);
    });

    test('an agent with no cap of its own gets the default one, lowered and restored like any other, and its pause survives a restart', () => {
        const { limits, advance, now } = clocked();

        expect(limits.capOf('cursor')).toBe(4);
        limits.warn('cursor');
        expect(limits.capOf('cursor')).toBe(2);
        limits.transientFailure('cursor');
        expect(limits.nextChange()).toBe(now() + 5 * MINUTE);
        advance(5 * MINUTE);
        expect(limits.capOf('cursor')).toBe(2);
        advance(5 * MINUTE);
        expect(limits.capOf('cursor')).toBe(4);

        const restarted = new EngineLimits({ claude: 6 }, { store: { pauses: [{ engine: 'my-agent', until: now() + MINUTE }], save: () => undefined }, clock: now, defaultCap: 3 });

        expect(restarted.pausedUntil('my-agent')).toBe(now() + MINUTE);
        expect(restarted.capOf('my-agent')).toBe(3);
        expect(restarted.nextChange()).toBe(now() + MINUTE);
    });

    test('a rejection without a reset time pauses for five minutes', () => {
        const { limits, now } = clocked();

        expect(limits.pause('codex')).toBe(now() + 5 * MINUTE + 15_000);
    });

    test('says when something changes by itself, so the scheduler can look again then', () => {
        const { limits, advance, now } = clocked();

        expect(limits.nextChange()).toBeUndefined();
        limits.warn('claude');
        limits.transientFailure('codex');
        expect(limits.nextChange()).toBe(now() + 5 * MINUTE);
        limits.pause('fake', now() + MINUTE);
        expect(limits.nextChange()).toBe(now() + MINUTE + 15_000);
        advance(6 * MINUTE);
        expect(limits.nextChange()).toBe(now() + 4 * MINUTE);
    });

    test('limit events are read in one place: epoch seconds and milliseconds both give milliseconds', () => {
        expect(parseLimit({ type: 'limit', status: 'rejected', resetsAt: 1_800_000_000 })).toEqual({ status: 'rejected', resetsAt: 1_800_000_000_000 });
        expect(parseLimit({ type: 'limit', status: 'rejected', resetsAt: 1_800_000_000_000 })).toEqual({ status: 'rejected', resetsAt: 1_800_000_000_000 });
        expect(parseLimit({ type: 'limit', status: 'warning', kind: 'five_hour', utilization: 0.9 })).toEqual({ status: 'warning', kind: 'five_hour', utilization: 0.9 });
        expect(parseLimit({ type: 'limit', status: 'rejected', resetsAt: 0 })).toEqual({ status: 'rejected' });
    });

    test('backoff doubles from the base up to five minutes, with jitter between half and all of it', () => {
        expect([1, 2, 3, 4].map(attempt => backoffDelay(attempt, 5000, () => 1))).toEqual([5000, 10_000, 20_000, 40_000]);
        expect(backoffDelay(3, 5000, () => 0)).toBe(10_000);
        expect(backoffDelay(20, 5000, () => 1)).toBe(5 * MINUTE);
        expect(backoffDelay(20, 5000, () => 0)).toBe(2.5 * MINUTE);
    });
});

async function setup(script: Script, overrides: Parameters<typeof startHarness>[0] = {}) {
    const engine = new ScriptEngine(script);
    const h = await startHarness(overrides, { engines: scriptEngines(engine) });

    harnesses.push(h);

    const project = h.openRepo();
    const start = (title: string) => h.ok('task.start', { taskId: h.ok('task.create', { projectId: project.id, title }).task.id }).runId as string;

    return { h, engine, project, start, limits: h.daemon.services.runs.limits };
}

describe('the scheduler and the engine caps', () => {
    test('an engine cap holds runs back even when the global cap has room, and says why', async () => {
        const gate = latch();
        const { h, engine, start } = await setup(async function* ({ signal }) {
            yield { type: 'session', sessionId: `s${ engine.turns.length }` };
            await gate.wait(signal);
            yield { type: 'done' };
        }, { engineCaps: { claude: 6, codex: 4, fake: 2 } });
        const runs = [start('A'), start('B'), start('C'), start('D')];

        await waitFor(() => engine.turns.length === 2, 'two sessions');
        expect(runs.map(id => h.run(id).status)).toEqual(['running', 'running', 'queued', 'queued']);
        expect(h.run(runs[2]).statusReason).toBe('Waiting for a free slot');
        gate.release();
        await waitFor(() => runs.every(id => h.run(id).status === 'succeeded'), 'everything to finish');
    });

    test('a warning makes an engine run half as many at once for a while', async () => {
        const gate = latch();
        const { h, engine, start, limits } = await setup(async function* ({ signal, number }) {
            yield { type: 'session', sessionId: `s${ number }` };

            if (number === 1) {
                yield { type: 'limit', status: 'warning', kind: 'five_hour', utilization: 0.91 };
            }

            await gate.wait(signal);
            yield { type: 'done' };
        }, { engineCaps: { claude: 6, codex: 4, fake: 4 } });
        const first = start('A');

        await waitFor(() => limits.capOf('fake') === 2, 'the warning');

        const rest = [start('B'), start('C'), start('D')];

        await waitFor(() => h.run(rest[0]).status === 'running', 'the second run');
        await Bun.sleep(30);
        expect([first, ...rest].map(id => h.run(id).status)).toEqual(['running', 'running', 'queued', 'queued']);
        expect(engine.turns).toHaveLength(2);
    });
});

describe('subscription limits', () => {
    const resetIn = (ms: number) => Date.now() + ms;

    test('a rejection blocks the live run with the reset time, keeps new runs waiting, and continues the same session afterwards', async () => {
        const resets = resetIn(500);
        const { h, engine, start, limits, project } = await setup(async function* ({ options, signal, number }) {
            if (options.resumeSessionId) {
                yield { type: 'session', sessionId: options.resumeSessionId };
                yield { type: 'text', delta: 'Back at it.', done: true };
                yield { type: 'done', result: 'finished after the reset' };

                return;
            }

            yield { type: 'session', sessionId: `s${ number }` };

            if (number === 1) {
                yield { type: 'limit', status: 'rejected', kind: 'five_hour', resetsAt: resets };
                await untilAborted(signal);
            }

            yield { type: 'done', result: 'second run' };
        });
        const first = start('A');

        await waitFor(() => h.run(first).status === 'blocked', 'the run to wait for the reset');
        expect(h.run(first).statusReason).toMatch(/^The fake engine is at its usage limit until .+; this run continues then$/);
        expect(limits.pausedUntil('fake')).toBe(resets);
        expect((h.store.db.query('SELECT until FROM engine_pauses').get() as { until: number }).until).toBe(resets);

        // The user is told once; a run that wants to start meanwhile waits and says why.
        const notice = h.events().find(event => event.data.type === 'notice');

        expect(notice?.data).toMatchObject({ level: 'warn', text: expect.stringContaining('The fake engine reached its usage limit; its runs continue at') });

        const second = start('B');

        await Bun.sleep(100);
        expect(h.run(second)).toMatchObject({ status: 'queued', statusReason: expect.stringContaining('The fake engine is at its usage limit until') });
        expect(engine.turns).toHaveLength(1);

        await waitFor(() => h.run(first).status === 'succeeded', 'the run to continue after the reset', 5000);
        expect(Date.now()).toBeGreaterThanOrEqual(resets);

        const resumed = engine.turns.find(options => options.resumeSessionId);

        expect({ resumeSessionId: resumed?.resumeSessionId, prompt: resumed?.prompt }).toEqual({ resumeSessionId: 's1', prompt: CONTINUE_MESSAGE });
        expect(h.run(first)).toMatchObject({ result: 'finished after the reset', sessionId: 's1' });
        await waitFor(() => h.run(second).status === 'succeeded', 'the waiting run to start');
        expect(h.store.db.query('SELECT COUNT(*) AS n FROM engine_pauses').get()).toEqual({ n: 0 });
        expect(h.events().filter(event => event.data.type === 'notice')).toHaveLength(1);
        expect(project.id).toBeTruthy();
    });

    test('every live run of the engine stops at once, not only the one that saw the rejection', async () => {
        const resets = resetIn(300);
        const never = latch();
        const { h, engine, start } = await setup(async function* ({ options, signal, number }) {
            yield { type: 'session', sessionId: options.resumeSessionId ?? `s${ number }` };

            if (options.resumeSessionId) {
                yield { type: 'done', result: 'resumed' };

                return;
            }

            if (number === 3) {
                yield { type: 'limit', status: 'rejected', resetsAt: resets };
            }

            await never.wait(signal);
        });
        const runs = [start('A'), start('B')];

        await waitFor(() => engine.turns.length === 2, 'two live runs');

        const third = start('C');

        await waitFor(() => runs.every(id => h.run(id).status === 'blocked') && h.run(third).status === 'blocked', 'all three to wait for the reset');
        await waitFor(() => [...runs, third].every(id => h.run(id).status === 'succeeded'), 'all three to continue', 5000);
        expect(engine.turns.filter(options => options.resumeSessionId)).toHaveLength(3);
    });

    test('a reset more than a day away pauses the engine, says so with an error notice, and the pause survives a restart', async () => {
        const resets = resetIn(2 * 24 * 60 * MINUTE);
        const { h, start, limits } = await setup(async function* ({ signal }) {
            yield { type: 'session', sessionId: 's1' };
            yield { type: 'limit', status: 'rejected', kind: 'seven_day', resetsAt: Math.floor(resets / 1000) };
            await untilAborted(signal);
        });
        const first = start('A');

        await waitFor(() => h.run(first).status === 'blocked', 'the run to wait');
        expect(limits.pausedUntil('fake')).toBe(Math.floor(resets / 1000) * 1000);
        expect(h.events().find(event => event.data.type === 'notice')?.data).toMatchObject({ level: 'error', text: expect.stringContaining('more than a day from now') });
        await h.stop();

        const next = new ScriptEngine(async function* () {
            yield { type: 'done' };
        });
        const second = await restartHarness(h, { engines: scriptEngines(next) });

        harnesses.push(second);
        expect(second.daemon.services.runs.limits.pausedUntil('fake')).toBe(Math.floor(resets / 1000) * 1000);

        // The run that waited for the reset waits again, and nothing is started against the empty quota.
        await waitFor(() => second.run(first).status === 'queued', 'the blocked run to queue behind the pause');
        expect(second.run(first).statusReason).toContain('The fake engine is at its usage limit until');
        await Bun.sleep(50);
        expect(next.turns).toHaveLength(0);
    });
});

describe('transient engine failures', () => {
    const overloaded = { type: 'error', message: 'Overloaded (529)', retryable: true } as const;

    test('a retryable error blocks the run for a backoff, lowers the cap, and continues the same session', async () => {
        const { h, engine, start, limits } = await setup(async function* ({ options, number }) {
            yield { type: 'session', sessionId: options.resumeSessionId ?? `s${ number }` };

            if (number === 1) {
                yield overloaded;

                return;
            }

            yield { type: 'done', result: 'recovered' };
        }, { engineCaps: { claude: 6, codex: 4, fake: 3 }, timings: { ...SHORT_TIMINGS, retryBaseMs: 80 } });
        const runId = start('A');

        await waitFor(() => h.run(runId).status === 'blocked', 'the backoff');
        expect(h.run(runId).statusReason).toMatch(/^The fake engine is busy \(Overloaded \(529\)\); trying again in \d+ s$/);
        expect(limits.capOf('fake')).toBe(2);
        await waitFor(() => h.run(runId).status === 'succeeded', 'the retry to succeed');
        expect({ resumeSessionId: engine.turns[1].resumeSessionId, prompt: engine.turns[1].prompt }).toEqual({ resumeSessionId: 's1', prompt: CONTINUE_MESSAGE });
        expect(h.run(runId).result).toBe('recovered');
    });

    test('before any session id exists the turn starts again from its own message', async () => {
        const { h, engine, start } = await setup(async function* ({ number }) {
            if (number === 1) {
                yield overloaded;

                return;
            }

            yield { type: 'session', sessionId: 's2' };
            yield { type: 'done' };
        });
        const runId = start('A');

        await waitFor(() => h.run(runId).status === 'succeeded', 'the retry to succeed');
        expect(engine.turns[1].resumeSessionId).toBeUndefined();
        expect(engine.turns[1].prompt).toBe(engine.turns[0].prompt);
    });

    test('a run that keeps failing is given up after a few tries, and the cap keeps falling', async () => {
        const { h, engine, start, limits } = await setup(async function* () {
            yield overloaded;
        }, { engineCaps: { claude: 6, codex: 4, fake: 10 } });
        const runId = start('A');

        await waitFor(() => h.run(runId).status === 'failed', 'the run to be given up', 5000);
        expect(engine.turns).toHaveLength(5);
        expect(h.run(runId).error).toBe('Overloaded (529)');
        expect(limits.capOf('fake')).toBe(6);
    });

    test('an error that is not retryable fails the run at once', async () => {
        const { h, engine, start, limits } = await setup(async function* () {
            yield { type: 'error', message: 'Invalid API key' };
        });
        const runId = start('A');

        await waitFor(() => h.run(runId).status === 'failed', 'the failure');
        expect(h.run(runId).error).toBe('Invalid API key');
        expect(engine.turns).toHaveLength(1);
        expect(limits.capOf('fake')).toBe(testConfig().engineCaps.fake);
    });
});
