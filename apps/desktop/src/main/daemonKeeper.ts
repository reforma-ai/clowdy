import { type FSWatcher, watch as fsWatch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { type DaemonInfo, type Health, PROTOCOL_VERSION } from '@clowdy/protocol';

import { type DaemonContext, ensureDaemon, findRunning, type RunningDaemon, stopDaemon } from './daemon';

/** After a source file changes, how long to wait for the editing to settle before looking. */
const DEBOUNCE_MS = 1000;
/** How often a daemon that is still working is asked again whether it is idle. */
const BUSY_RETRY_MS = 5000;

/** A source file of the daemon: not a test, not a dependency. */
export function isDaemonSource(file: string): boolean {
    const parts = file.split(/[\\/]/);

    return (
        /\.(ts|json)$/.test(file) &&
        !/\.test\.ts$/.test(file) &&
        !parts.includes('node_modules') &&
        !parts.includes('test')
    );
}

/** The latest modification time, in milliseconds, of the daemon's source files under `dirs`. 0 when there are none. */
export async function newestSourceTime(dirs: readonly string[]): Promise<number> {
    let newest = 0;

    for (const dir of dirs) {
        const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
        const times = await Promise.all(
            entries
                .filter(entry => entry.isFile() && isDaemonSource(path.join(entry.parentPath, entry.name)))
                .map(entry =>
                    stat(path.join(entry.parentPath, entry.name)).then(
                        ({ mtimeMs }) => mtimeMs,
                        () => 0
                    )
                )
        );

        newest = Math.max(newest, ...times);
    }

    return newest;
}

/** Whether the running daemon should give way to a new one. */
export type Staleness = (running: RunningDaemon) => boolean | Promise<boolean>;

/** The bundle a daemon was built into, by its health answer; undefined for one run from its sources (a package version). */
export function daemonBundle({ version }: Health): number | undefined {
    const bundle = Number(version);

    return Number.isSafeInteger(bundle) ? bundle : undefined;
}

/** A development run: the daemon started before the newest change to its sources, or runs a bundle (the test feed's). */
export function sourcesChangedSince(newestTime: () => Promise<number>): Staleness {
    return async ({ health }) => daemonBundle(health) !== undefined || (await newestTime()) > health.startedAt;
}

/**
 * The app runs a bundle: the daemon comes from an older one (what a shell or OTA update leaves behind), or from this
 * bundle but speaking another protocol. A newer daemon (a newer copy of the app started it, or a bundle that was rolled
 * back) stays: it may have migrated the database past what this bundle's daemon can open.
 */
export function fromOlderBundle(version: number): Staleness {
    return ({ health }) => {
        const running = daemonBundle(health);

        // A daemon run from its sources is no bundle's.
        if (running === undefined) return true;

        return running < version || (running === version && health.protocol !== PROTOCOL_VERSION);
    };
}

export type KeeperOutcome =
    /** No daemon runs; starting one is `ensureDaemon`'s business. */
    | { kind: 'none' }
    /** The running daemon is the one the app wants. */
    | { kind: 'fresh' }
    /** The daemon is stale but has runs in progress; a restart would interrupt them. */
    | { kind: 'busy'; pid: number; protocol: number; activeRuns: number | undefined }
    | { kind: 'restarted'; info: DaemonInfo }
    /** Stopping the stale daemon or starting the new one failed. */
    | { kind: 'failed'; error: unknown };

/**
 * Replaces the running daemon with a new one when it is stale, but only when it says it has no active runs: a restart
 * marks live runs interrupted, so work in progress is never cut short for it, unless `force` says the person chose to.
 */
export async function restartIfStale(
    context: DaemonContext,
    isStale: Staleness,
    force = false
): Promise<KeeperOutcome> {
    const running = await findRunning(context);

    if (!running) return { kind: 'none' };

    if (!(await isStale(running))) return { kind: 'fresh' };

    const { pid, protocol, activeRuns } = running.health;

    // A daemon that does not say how many runs it has is not restarted either: it may be in the middle of some.
    if (!force && (activeRuns === undefined || activeRuns > 0)) return { kind: 'busy', pid, protocol, activeRuns };

    await stopDaemon(context, running);

    return { kind: 'restarted', info: await ensureDaemon(context) };
}

export interface KeeperOptions {
    context: DaemonContext;
    isStale: Staleness;
    /** The daemon was replaced; the windows must be told where the new one is. */
    onRestarted: (info: DaemonInfo) => void;
    /** A stale daemon is busy. Called once per daemon process; `replaceNow` is the answer when the person wants it replaced anyway. */
    onBusy?: (busy: Extract<KeeperOutcome, { kind: 'busy' }>) => void;
    /** A replacement failed: the old daemon did not stop, or the new one did not start. */
    onFailed?: (error: unknown) => void;
    /** Folders whose changes make it look again: a development run's daemon sources. */
    dirs?: readonly string[];
    log?: (message: string) => void;
    /** For tests. */
    watch?: typeof fsWatch;
    debounceMs?: number;
    busyRetryMs?: number;
}

export interface DaemonKeeper {
    /** Looks now, and settles with what it found when the look (and any restart it led to) is over. */
    checkNow: () => Promise<KeeperOutcome>;
    /** Replaces a stale daemon even though it has runs in progress; they come back interrupted. */
    replaceNow: () => Promise<KeeperOutcome>;
    stop: () => void;
}

/**
 * Keeps the running daemon the one the app wants: it looks once on demand and again after each change under `dirs`,
 * and a stale daemon that was busy is looked at again every few seconds until it is idle.
 */
export function keepDaemonFresh({
    context,
    isStale,
    onRestarted,
    onBusy,
    onFailed,
    dirs = [],
    log = () => undefined,
    watch = fsWatch,
    debounceMs = DEBOUNCE_MS,
    busyRetryMs = BUSY_RETRY_MS,
}: KeeperOptions): DaemonKeeper {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: Promise<KeeperOutcome> | undefined;
    let again = false;
    let force = false;
    let stopped = false;
    /** The busy daemon `onBusy` was told about, so it is told once. */
    let reportedBusy: number | undefined;

    const schedule = (ms: number) => {
        clearTimeout(timer);

        if (!stopped) timer = setTimeout(() => void checkNow(), ms);
    };

    const look = async (): Promise<KeeperOutcome> => {
        const forced = force;

        force = false;

        try {
            const outcome = await restartIfStale(context, isStale, forced);

            if (outcome.kind === 'restarted') {
                log(`Restarted the daemon: now pid ${outcome.info.pid} on port ${outcome.info.port}.`);
                onRestarted(outcome.info);
            } else if (outcome.kind === 'busy') {
                log(
                    `The daemon is stale; waiting for ${outcome.activeRuns ?? 'its'} run(s) to finish before restarting it.`
                );
                schedule(busyRetryMs);

                if (reportedBusy !== outcome.pid) {
                    reportedBusy = outcome.pid;
                    onBusy?.(outcome);
                }
            }

            return outcome;
        } catch (error) {
            log(`Could not restart the daemon: ${error instanceof Error ? error.message : String(error)}`);
            onFailed?.(error);

            return { kind: 'failed', error };
        }
    };

    // One look at a time; a change that arrives during one asks for another when it ends.
    function checkNow(): Promise<KeeperOutcome> {
        if (current) {
            again = true;

            return current;
        }

        current = (async () => {
            let outcome: KeeperOutcome;

            do {
                again = false;
                outcome = await look();
            } while (again && !stopped);

            return outcome;
        })().finally(() => {
            current = undefined;
        });

        return current;
    }

    const watchers: FSWatcher[] = dirs.map(dir =>
        watch(dir, { recursive: true }, (_event, file) => {
            if (file && isDaemonSource(String(file))) schedule(debounceMs);
        })
    );

    return {
        checkNow,
        replaceNow: async () => {
            // A look already running would end without the force; the next one takes it.
            await current;
            force = true;

            return checkNow();
        },
        stop() {
            stopped = true;
            clearTimeout(timer);
            watchers.forEach(watcher => watcher.close());
        },
    };
}
