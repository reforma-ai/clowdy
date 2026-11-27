/**
 * Signals the process tree of `pid`, a program the daemon started as the leader of its own group (`detached`): every process of the group on POSIX. On Windows, which has
 * no groups, `taskkill /T /F` ends the tree whatever the signal, and the daemon does not wait for it (a sync `taskkill` stops everything for tens of milliseconds). Returns
 * whether the signal went out: `false` when the group is gone already.
 */
export function killTree(pid: number, signal: NodeJS.Signals): boolean {
    try {
        if (process.platform === 'win32') {
            Bun.spawn(['taskkill', '/PID', String(pid), '/T', '/F'], {
                stdin: 'ignore',
                stdout: 'ignore',
                stderr: 'ignore',
                windowsHide: true,
            });
        } else {
            process.kill(-pid, signal);
        }

        return true;
    } catch {
        // The group is already gone, or `taskkill` could not be started.
        return false;
    }
}

/** Whether any process is still in the group `pgid`; one that has exited and not been reaped counts. Always false on Windows, which has no groups. */
export function processGroupAlive(pgid: number): boolean {
    if (process.platform === 'win32') return false;

    try {
        process.kill(-pgid, 0);

        return true;
    } catch (error) {
        // `EPERM` is a group that is there and is not ours to signal; `ESRCH` is one that is gone.
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}
