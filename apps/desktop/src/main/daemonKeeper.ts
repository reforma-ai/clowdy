import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { ensureDaemon, findRunning, stopDaemon, type DaemonContext } from './daemon';

import type { DaemonInfo } from '@clowdy/protocol';

/** After a source file changes, how long to wait for the editing to settle before looking. */
const DEBOUNCE_MS = 1000;
/** How often a daemon that is still working is asked again whether it is idle. */
const BUSY_RETRY_MS = 5000;

/** A source file of the daemon: not a test, not a dependency. */
export function isDaemonSource(file: string): boolean {
    const parts = file.split(/[\\/]/);

    return /\.(ts|json)$/.test(file) && !/\.test\.ts$/.test(file) && !parts.includes('node_modules') && !parts.includes('test');
}

/** The latest modification time, in milliseconds, of the daemon's source files under `dirs`. 0 when there are none. */
export async function newestSourceTime(dirs: readonly string[]): Promise<number> {
    let newest = 0;

    for (const dir of dirs) {
        const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
        const times = await Promise.all(entries
            .filter(entry => entry.isFile() && isDaemonSource(path.join(entry.parentPath, entry.name)))
            .map(entry => stat(path.join(entry.parentPath, entry.name)).then(({ mtimeMs }) => mtimeMs, () => 0)));

        newest = Math.max(newest, ...times);
    }

    return newest;
}

export type KeeperOutcome =
    /** No daemon runs; starting one is `ensureDaemon`'s business. */
    | { kind: 'none' }
    /** The running daemon started after the last source change. */
    | { kind: 'fresh' }
    /** The daemon is older than its sources but has runs in progress; a restart would interrupt them. */
    | { kind: 'busy'; activeRuns: number | undefined }
    | { kind: 'restarted'; info: DaemonInfo };

/**
 * Replaces the running daemon with a new one when its sources changed since it started, but only when it says it has no
 * active runs: a restart marks live runs interrupted, so work in progress is never cut short for it.
 */
export async function restartIfStale(context: DaemonContext, newestTime: () => Promise<number>): Promise<KeeperOutcome> {
    const running = await findRunning(context);

    if (!running) return { kind: 'none' };

    if (await newestTime() <= running.health.startedAt) return { kind: 'fresh' };

    const { activeRuns } = running.health;

    // A daemon that does not say how many runs it has is not restarted either: it may be in the middle of some.
    if (activeRuns === undefined || activeRuns > 0) return { kind: 'busy', activeRuns };

    await stopDaemon(context, running);

    return { kind: 'restarted', info: await ensureDaemon(context) };
}

export interface KeeperOptions {
    context: DaemonContext;
    /** Folders with the sources the daemon runs from. */
    dirs: readonly string[];
    /** The daemon was replaced; the windows must be told where the new one is. */
    onRestarted: (info: DaemonInfo) => void;
    log?: (message: string) => void;
    /** For tests. */
    watch?: typeof fsWatch;
    newestTime?: () => Promise<number>;
    debounceMs?: number;
    busyRetryMs?: number;
}

export interface DaemonKeeper {
    /** Looks now, and settles when the look (and any restart it led to) is over. */
    checkNow: () => Promise<void>;
    stop: () => void;
}

/**
 * Keeps the daemon of a development run in step with its sources: it looks once on demand and again after each
 * change under `dirs`, and a daemon that was busy is looked at again every few seconds until it is idle.
 */
export function keepDaemonFresh({ context, dirs, onRestarted, log = () => undefined, watch = fsWatch, newestTime = () => newestSourceTime(dirs), debounceMs = DEBOUNCE_MS, busyRetryMs = BUSY_RETRY_MS }: KeeperOptions): DaemonKeeper {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: Promise<void> | undefined;
    let again = false;
    let stopped = false;

    const schedule = (ms: number) => {
        clearTimeout(timer);

        if (!stopped) timer = setTimeout(() => void checkNow(), ms);
    };

    const look = async () => {
        try {
            const outcome = await restartIfStale(context, newestTime);

            if (outcome.kind === 'restarted') {
                log(`Restarted the daemon: now pid ${ outcome.info.pid } on port ${ outcome.info.port }.`);
                onRestarted(outcome.info);
            }
            else if (outcome.kind === 'busy') {
                log(`The daemon is older than its sources; waiting for ${ outcome.activeRuns ?? 'its' } run(s) to finish before restarting it.`);
                schedule(busyRetryMs);
            }
        }
        catch (error) {
            log(`Could not restart the daemon: ${ error instanceof Error ? error.message : String(error) }`);
        }
    };

    // One look at a time; a change that arrives during one asks for another when it ends.
    function checkNow(): Promise<void> {
        if (current) {
            again = true;

            return current;
        }

        current = (async () => {
            do {
                again = false;
                await look();
            } while (again && !stopped);
        })().finally(() => {
            current = undefined;
        });

        return current;
    }

    const watchers: FSWatcher[] = dirs.map(dir => watch(dir, { recursive: true }, (_event, file) => {
        if (file && isDaemonSource(String(file))) schedule(debounceMs);
    }));

    return {
        checkNow,
        stop() {
            stopped = true;
            clearTimeout(timer);
            watchers.forEach(watcher => watcher.close());
        },
    };
}
