import { processesBelow, signalBelow } from '../engine/process';
import { killTree } from '../process/kill';

import type { RunProcess } from '../db/runs';

/** The start time an engine reports and the one the OS shows for the same process differ by about a second. */
const START_TOLERANCE_MS = 5000;

/** How long `ps` gets to say when a process started; the daemon waits for it, and without an answer the start time is unknown. */
const PS_TIMEOUT_MS = 2000;

export function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);

        return true;
    } catch (error) {
        // EPERM: the process exists but belongs to someone else.
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/**
 * When the OS says the process started (epoch ms, to the second), so a recycled pid can be told from the original.
 * `undefined` when the process is gone or the platform has no cheap way to ask (Windows).
 */
export function startTimeOf(pid: number): number | undefined {
    if (process.platform === 'win32') {
        return undefined;
    }

    // Elapsed time rather than the start date: the date is printed in local time, which moves with the zone and daylight saving.
    const text = Bun.spawnSync(['ps', '-o', 'etime=', '-p', String(pid)], {
        stdout: 'pipe',
        stderr: 'ignore',
        timeout: PS_TIMEOUT_MS,
    })
        .stdout.toString()
        .trim();
    const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text);

    if (!match) {
        return undefined;
    }

    const [days, hours, minutes, seconds] = match.slice(1).map(part => Number(part ?? 0));

    return Date.now() - (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

/** Fills in the start time from the OS, which is what a later check compares with. */
export function describeProcess(ref: RunProcess): RunProcess {
    return { ...ref, startedAt: startTimeOf(ref.pid) ?? ref.startedAt };
}

/** Whether `ref.pid` is still the process that was recorded: alive, and started when it was said to. */
export function isSameProcess(ref: RunProcess): boolean {
    if (!isAlive(ref.pid)) {
        return false;
    }

    const started = startTimeOf(ref.pid);

    // Without a start time on either side nothing tells a reused pid apart, so leave it alone.
    return (
        started !== undefined && ref.startedAt !== undefined && Math.abs(started - ref.startedAt) <= START_TOLERANCE_MS
    );
}

/** A recorded process may still be the agent when it is alive and cannot be proved to have a different start time. */
export function mayBeSameProcess(ref: RunProcess): boolean {
    if (!isAlive(ref.pid)) return false;
    const started = startTimeOf(ref.pid);
    return (
        started === undefined || ref.startedAt === undefined || Math.abs(started - ref.startedAt) <= START_TOLERANCE_MS
    );
}

/** Signals the process group of a run's engine (the whole tree), or the process alone when it has no group of its own. */
export function signalProcess(ref: RunProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
    if (process.platform === 'win32') {
        killTree(ref.pid, signal);

        return;
    }

    for (const target of ref.pgid ? [-ref.pgid, ref.pid] : [ref.pid]) {
        try {
            process.kill(target, signal);

            return;
        } catch {
            // The group is gone; try the process alone, then give up.
        }
    }
}

/** Stops a process left over from before a restart: SIGTERM, a grace period, SIGKILL. Returns whether it was still running. */
export async function killSurvivor(ref: RunProcess, graceMs: number): Promise<boolean> {
    if (!isSameProcess(ref)) {
        return false;
    }

    // What it started in groups of their own (Claude Code's shell commands) is not in its group, and belongs to nobody once it is gone.
    const below = processesBelow(ref.pid);

    signalProcess(ref, 'SIGTERM');
    signalBelow(below, ref.pgid ?? ref.pid, 'SIGTERM');

    for (const deadline = Date.now() + graceMs; Date.now() < deadline && isAlive(ref.pid); ) {
        await Bun.sleep(50);
    }

    if (isAlive(ref.pid)) {
        signalProcess(ref, 'SIGKILL');
    }

    signalBelow(below, ref.pgid ?? ref.pid, 'SIGKILL');

    return true;
}
