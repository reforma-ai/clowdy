import { PROTOCOL_VERSION, type DaemonInfo, type Health } from '@clowdy/protocol';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { type DaemonContext } from './daemon';
import { fromOlderBundle, isDaemonSource, keepDaemonFresh, newestSourceTime, restartIfStale, sourcesChangedSince } from './daemonKeeper';

import type { DaemonHost } from './daemonHost';

const DATA_DIR = '/data/daemon';
const INFO_FILE = path.join(DATA_DIR, 'daemon.json');

interface World {
    files: Map<string, string>;
    daemons: Map<number, Health>;
    /** When each daemon process ends, by pid: never while it runs. */
    endsAt: Map<number, number>;
    stops: number;
    launches: number;
    clock: number;
    nextPid: number;
}

/**
 * A machine in memory with one daemon on it, started at `startedAt`, with `activeRuns` runs in progress. A daemon asked to
 * stop answers no more at once and its process ends `windDownMs` later.
 */
function setup({ running = true, startedAt = 1000, activeRuns = 0, version = '0.0.1', protocol = PROTOCOL_VERSION, windDownMs = 0 }: { running?: boolean; startedAt?: number; activeRuns?: number; version?: string; protocol?: number; windDownMs?: number } = {}) {
    const world: World = { files: new Map(), daemons: new Map(), endsAt: new Map(), stops: 0, launches: 0, clock: startedAt + 5000, nextPid: 100 };
    const publish = (startedAtOfNew: number, runs: number, ofVersion = '412', ofProtocol = PROTOCOL_VERSION): DaemonInfo => {
        const info: DaemonInfo = { pid: world.nextPid++, port: 50000 + world.nextPid, token: 't', protocol: ofProtocol, startedAt: startedAtOfNew };

        world.files.set(INFO_FILE, JSON.stringify(info));
        world.daemons.set(info.port, { ok: true, protocol: ofProtocol, version: ofVersion, pid: info.pid, startedAt: startedAtOfNew, activeRuns: runs });
        world.endsAt.set(info.pid, Infinity);

        return info;
    };

    if (running) publish(startedAt, activeRuns, version, protocol);

    const host: DaemonHost = {
        readText: async file => world.files.get(file),
        readLogTail: async () => '',
        probe: async port => world.daemons.get(port),
        launch: () => {
            world.launches += 1;
            publish(world.clock, 0);

            return new Promise(() => undefined);
        },
        stop: async ({ port, pid }) => {
            world.stops += 1;
            world.daemons.delete(port);
            world.files.delete(INFO_FILE);
            world.endsAt.set(pid, world.clock + windDownMs);
        },
        alive: pid => (world.endsAt.get(pid) ?? 0) > world.clock,
        loginPath: async () => undefined,
        sleep: async (ms) => {
            world.clock += ms;
        },
        now: () => world.clock,
    };
    const context: DaemonContext = {
        host,
        platform: 'darwin',
        env: { PATH: '/usr/bin' },
        dataDir: DATA_DIR,
        runtime: { bun: '/bin/bun', entry: '/repo/apps/daemon/src/main.ts' },
    };

    return { world, context, setRuns: (runs: number) => world.daemons.forEach((health, port) => world.daemons.set(port, { ...health, activeRuns: runs })) };
}

describe('restartIfStale', () => {
    test('does nothing when no daemon runs', async () => {
        const { world, context } = setup({ running: false });

        expect(await restartIfStale(context, sourcesChangedSince(async () => 9_999))).toEqual({ kind: 'none' });
        expect([world.stops, world.launches]).toEqual([0, 0]);
    });

    test('leaves a daemon that started after the last source change', async () => {
        const { world, context } = setup({ startedAt: 1000 });

        expect(await restartIfStale(context, sourcesChangedSince(async () => 1000))).toEqual({ kind: 'fresh' });
        expect([world.stops, world.launches]).toEqual([0, 0]);
    });

    test('replaces a bundle\'s daemon, which a run on the test feed left, with one from the sources', async () => {
        const { world, context } = setup({ startedAt: 1000, version: '412' });

        expect(await restartIfStale(context, sourcesChangedSince(async () => 0))).toMatchObject({ kind: 'restarted' });
        expect([world.stops, world.launches]).toEqual([1, 1]);
    });

    test('waits while the stale daemon has runs in progress, so nothing is interrupted', async () => {
        const { world, context } = setup({ startedAt: 1000, activeRuns: 2 });

        expect(await restartIfStale(context, sourcesChangedSince(async () => 2000))).toMatchObject({ kind: 'busy', activeRuns: 2 });
        expect([world.stops, world.launches]).toEqual([0, 0]);
    });

    test('does not restart a stale daemon that does not say how many runs it has', async () => {
        const { world, context } = setup({ startedAt: 1000 });
        const silent = { ...context, host: { ...context.host, probe: async (port: number) => {
            const { activeRuns: _runs, ...health } = (await context.host.probe(port))!;

            return health;
        } } };

        expect(await restartIfStale(silent, sourcesChangedSince(async () => 2000))).toMatchObject({ kind: 'busy', activeRuns: undefined });
        expect(world.stops).toBe(0);
    });

    test('replaces an idle stale daemon with a new one', async () => {
        const { world, context } = setup({ startedAt: 1000, activeRuns: 0 });
        const outcome = await restartIfStale(context, sourcesChangedSince(async () => 2000));

        expect(outcome.kind).toBe('restarted');
        expect([world.stops, world.launches]).toEqual([1, 1]);
        expect(world.daemons.size).toBe(1);
        expect(outcome.kind === 'restarted' && outcome.info.startedAt).toBeGreaterThan(1000);
    });

    test('starts the new daemon once the stale one has ended, not when it stops answering: it holds the lock until then', async () => {
        const { world, context } = setup({ startedAt: 1000, windDownMs: 1500 });
        const { pid: stale } = JSON.parse(world.files.get(INFO_FILE)!) as DaemonInfo;
        let staleRanAtLaunch: boolean | undefined;
        const launch: DaemonHost['launch'] = (options) => {
            staleRanAtLaunch = context.host.alive(stale);

            return context.host.launch(options);
        };

        expect(await restartIfStale({ ...context, host: { ...context.host, launch } }, sourcesChangedSince(async () => 2000), true)).toMatchObject({ kind: 'restarted' });
        expect(staleRanAtLaunch).toBe(false);
    });

    test('starts nothing when the stale daemon does not end', async () => {
        const { world, context } = setup({ startedAt: 1000, windDownMs: Infinity });

        await expect(restartIfStale(context, sourcesChangedSince(async () => 2000))).rejects.toThrow('did not stop within 30 seconds');
        expect(world.launches).toBe(0);
    });
});

describe('keepDaemonFresh', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    function watched(overrides: Partial<Parameters<typeof keepDaemonFresh>[0]> & { context: DaemonContext }) {
        const changes: Array<(event: string, file: string | null) => void> = [];
        const closed: boolean[] = [];
        const restarted: DaemonInfo[] = [];
        const keeper = keepDaemonFresh({
            dirs: ['/repo/apps/daemon/src'],
            isStale: () => false,
            onRestarted: info => restarted.push(info),
            watch: ((_dir: string, _options: unknown, listener: (event: string, file: string | null) => void) => {
                changes.push(listener);

                return { close: () => closed.push(true) };
            }) as never,
            debounceMs: 1000,
            busyRetryMs: 5000,
            ...overrides,
        });

        return { keeper, changes, closed, restarted };
    }

    test('restarts an idle daemon once after a burst of changes, and tells the windows', async () => {
        const { world, context } = setup({ startedAt: 1000 });
        const { changes, restarted } = watched({ context, isStale: sourcesChangedSince(async () => 2000) });

        changes[0]('change', 'runs/driver.ts');
        changes[0]('change', 'runs/service.ts');
        await vi.advanceTimersByTimeAsync(999);
        expect(world.stops).toBe(0);

        await vi.advanceTimersByTimeAsync(1);
        expect(world.stops).toBe(1);
        expect(restarted).toHaveLength(1);
    });

    test('ignores tests and files that are not sources', async () => {
        const { world, context } = setup({ startedAt: 1000 });
        const { changes } = watched({ context, isStale: sourcesChangedSince(async () => 2000) });

        changes[0]('change', 'runs/driver.test.ts');
        changes[0]('change', 'notes.md');
        changes[0]('change', 'node_modules/x/index.ts');
        await vi.advanceTimersByTimeAsync(5000);

        expect(world.stops).toBe(0);
    });

    test('looks again every few seconds while the daemon is busy, and restarts it once idle', async () => {
        const { world, context, setRuns } = setup({ startedAt: 1000, activeRuns: 1 });
        const { changes, restarted } = watched({ context, isStale: sourcesChangedSince(async () => 2000) });

        changes[0]('change', 'runs/driver.ts');
        await vi.advanceTimersByTimeAsync(1000);
        expect(world.stops).toBe(0);

        await vi.advanceTimersByTimeAsync(5000);
        expect(world.stops).toBe(0);

        setRuns(0);
        await vi.advanceTimersByTimeAsync(5000);
        expect(world.stops).toBe(1);
        expect(restarted).toHaveLength(1);
    });

    test('a change saved while the daemon restarts leads to another restart', async () => {
        const { world, context } = setup({ startedAt: 1000 });
        let newest = 2000;
        let saved = false;
        const launch: DaemonHost['launch'] = (options) => {
            const exited = context.host.launch(options);

            if (!saved) {
                saved = true;
                newest = world.clock + 1;
                changes[0]('change', 'runs/driver.ts');
            }

            return exited;
        };
        const { changes } = watched({ context: { ...context, host: { ...context.host, launch } }, isStale: sourcesChangedSince(async () => newest) });

        changes[0]('change', 'runs/service.ts');
        await vi.advanceTimersByTimeAsync(1000);
        expect(world.stops).toBe(1);

        await vi.advanceTimersByTimeAsync(1000);
        expect(world.stops).toBe(2);
    });

    test('checkNow settles after the restart it led to, and stop closes the watchers', async () => {
        const { world, context } = setup({ startedAt: 1000 });
        const { keeper, closed } = watched({ context, isStale: sourcesChangedSince(async () => 2000) });

        await keeper.checkNow();
        expect(world.stops).toBe(1);

        keeper.stop();
        expect(closed).toEqual([true]);
    });

    test('reports a failure to restart and keeps watching', async () => {
        const { context } = setup({ startedAt: 1000 });
        const log = vi.fn();
        const failing = { ...context, host: { ...context.host, stop: async () => Promise.reject(new Error('boom')) } };
        const onFailed = vi.fn();
        const { keeper } = watched({ context: failing, isStale: sourcesChangedSince(async () => 2000), log, onFailed });

        expect(await keeper.checkNow()).toMatchObject({ kind: 'failed', error: new Error('boom') });
        expect(onFailed).toHaveBeenCalledWith(new Error('boom'));
        expect(log).toHaveBeenCalledWith(expect.stringContaining('Could not restart the daemon: boom'));
    });
});

describe('a packaged app', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('a daemon from an older bundle, from sources, or of another protocol is stale; its own and a newer one are not', async () => {
        const isStale = fromOlderBundle(412);
        const cases = [
            ['412', PROTOCOL_VERSION, false],
            ['411', PROTOCOL_VERSION, true],
            ['0.0.1', PROTOCOL_VERSION, true],
            ['412', PROTOCOL_VERSION + 1, true],
            // A newer copy of the app started it, and its database may be past what this bundle opens.
            ['413', PROTOCOL_VERSION, false],
            ['413', PROTOCOL_VERSION + 1, false],
        ] as const;

        for (const [version, protocol, stale] of cases) {
            const { context } = setup({ version, protocol });

            expect((await restartIfStale(context, isStale)).kind).toBe(stale ? 'restarted' : 'fresh');
        }
    });

    test('a busy daemon from another bundle is reported once, swapped once idle, and the windows are told', async () => {
        const { world, context, setRuns } = setup({ version: '411', activeRuns: 2 });
        const busy = vi.fn();
        const restarted = vi.fn();
        const keeper = keepDaemonFresh({ context, isStale: fromOlderBundle(412), onRestarted: restarted, onBusy: busy, busyRetryMs: 5000 });

        expect(await keeper.checkNow()).toMatchObject({ kind: 'busy', activeRuns: 2, protocol: PROTOCOL_VERSION });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(busy).toHaveBeenCalledOnce();
        expect(world.stops).toBe(0);

        setRuns(0);
        await vi.advanceTimersByTimeAsync(5000);
        expect(world.stops).toBe(1);
        expect(restarted).toHaveBeenCalledOnce();
        keeper.stop();
    });

    test('replaceNow swaps a busy daemon at once when the person chooses to', async () => {
        const { world, context } = setup({ version: '411', activeRuns: 3 });
        const restarted = vi.fn();
        const keeper = keepDaemonFresh({ context, isStale: fromOlderBundle(412), onRestarted: restarted });

        await keeper.checkNow();
        expect(world.stops).toBe(0);

        expect((await keeper.replaceNow())?.kind).toBe('restarted');
        expect(world.stops).toBe(1);
        expect(restarted).toHaveBeenCalledOnce();

        // The new daemon is the app's own: nothing more to do.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(world.stops).toBe(1);
        keeper.stop();
    });
});

describe('daemon sources', () => {
    test('are TypeScript and JSON files that are not tests or dependencies', () => {
        expect(['runs/driver.ts', 'db/schema.json', 'a\\b\\c.ts'].map(isDaemonSource)).toEqual([true, true, true]);
        expect(['runs/driver.test.ts', 'test/helpers.ts', 'node_modules/x/a.ts', 'README.md'].map(isDaemonSource)).toEqual([false, false, false, false]);
    });

    test('newestSourceTime is the latest modification of a source, and 0 for a missing folder', async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'clowdy-keeper-'));

        try {
            mkdirSync(path.join(dir, 'runs'));
            mkdirSync(path.join(dir, 'test'));
            writeFileSync(path.join(dir, 'main.ts'), '');
            writeFileSync(path.join(dir, 'runs/driver.ts'), '');
            writeFileSync(path.join(dir, 'test/late.ts'), '');
            utimesSync(path.join(dir, 'main.ts'), 100, 100);
            utimesSync(path.join(dir, 'runs/driver.ts'), 300, 300);
            utimesSync(path.join(dir, 'test/late.ts'), 900, 900);

            expect(await newestSourceTime([dir])).toBe(300_000);
            expect(await newestSourceTime([path.join(dir, 'missing')])).toBe(0);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
