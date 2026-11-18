import { spawn, spawnSync } from 'node:child_process';

import type { ChildProcess } from 'node:child_process';

/** After a polite stop, the group gets this long before it is killed outright. */
const KILL_AFTER_MS = 2000;
const STDERR_TAIL_CHARS = 4000;

/** Signals every process of the group `pgid`. On Windows, which has no groups, it stops the process tree of `pgid`. */
export function killProcessGroup(pgid: number, signal: NodeJS.Signals): void {
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pgid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });

        return;
    }

    try {
        process.kill(-pgid, signal);
    }
    catch {
        // The group is already gone.
    }
}

export interface ProcessSpec {
    command: string;
    args: string[];
    cwd: string;
    /** The whole environment of the process; nothing is inherited. */
    env: Record<string, string>;
}

/** A started agent program. Its stdin and stdout are the ACP connection. */
export interface AgentProcess {
    readonly child: ChildProcess;
    /** The process id, which is also the id of its group (on Windows there are no groups, and it stands for the tree). */
    readonly pid: number;
    /** Settles when the process has exited. */
    readonly exited: Promise<void>;
    /** The last part of what the process wrote to stderr. */
    stderr(): string;
    /** Asks the group to stop (SIGTERM), then kills it after a short grace. Safe to call again. */
    stop(): void;
}

/**
 * Starts a program as the leader of its own process group. Stopping it then stops the tools it started too, and the
 * runtime can kill the group by the pid it was told about even after a daemon crash. Rejects with the spawn error
 * (`ENOENT` when the program is not there).
 */
export function spawnInOwnGroup({ command, args, cwd, env }: ProcessSpec): Promise<AgentProcess> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
        let stderr = '';
        let alive = true;
        let timer: ReturnType<typeof setTimeout> | undefined;

        // Nobody reading it would block the process once its pipe fills.
        child.stderr?.setEncoding('utf8').on('data', (text: string) => {
            stderr = (stderr + text).slice(-STDERR_TAIL_CHARS);
        });

        const exited = new Promise<void>((done) => {
            child.once('exit', () => {
                alive = false;
                clearTimeout(timer);

                // Whatever the agent's tools left running goes down with it.
                if (child.pid !== undefined) {
                    killProcessGroup(child.pid, 'SIGKILL');
                }

                done();
            });
            child.once('error', () => done());
        });

        child.once('error', reject);
        child.once('spawn', () => {
            child.off('error', reject);
            child.on('error', () => undefined);

            const pid = child.pid as number;

            resolve({
                child,
                pid,
                exited,
                stderr: () => stderr,
                stop() {
                    if (!alive || timer) {
                        return;
                    }

                    killProcessGroup(pid, 'SIGTERM');
                    timer = setTimeout(() => {
                        if (alive) {
                            killProcessGroup(pid, 'SIGKILL');
                        }
                    }, KILL_AFTER_MS);
                    timer.unref();
                },
            });
        });
    });
}
