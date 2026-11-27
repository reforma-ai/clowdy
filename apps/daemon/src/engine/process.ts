import { spawn, spawnSync } from 'node:child_process';

import { killTree } from '../process/kill';

import type { ChildProcess } from 'node:child_process';

/** After a polite stop, the group gets this long before it is killed outright. */
const KILL_AFTER_MS = 2000;
const STDERR_TAIL_CHARS = 4000;
/** How long a failure waits for what a process that is ending wrote last (`stderrOf`): it ends the wait as soon as the pipes close, so this bounds a leftover that holds one. */
const STDERR_WAIT_MS = 1000;

/** A process below an agent's own, and the group it is in. */
export interface Below {
    pid: number;
    pgid: number;
}

/** How long the OS gets to list the processes; the daemon waits for it (about 20 ms with a few hundred processes). */
const LIST_TIMEOUT_MS = 2000;

/**
 * The processes below `root` as the OS lists them now (the tools an agent started, and theirs). Some leave the agent's group: Claude Code runs every shell
 * command, a background one included, in a group of its own, which a signal to the agent's group never reaches, and which outlives the agent. Empty
 * where there are no groups to leave (Windows stops the whole tree), for the root of every process (0 and 1), and when the OS does not answer (no `ps`,
 * or none in time): a stop then does what it did before.
 */
export function processesBelow(root: number): Below[] {
    if (process.platform === 'win32' || root <= 1) {
        return [];
    }

    const listed =
        spawnSync('ps', ['-axo', 'pid=,ppid=,pgid='], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: LIST_TIMEOUT_MS,
        }).stdout ?? '';
    const children = new Map<number, Below[]>();

    for (const line of listed.split('\n')) {
        const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);

        if (Number.isInteger(pid) && Number.isInteger(ppid) && Number.isInteger(pgid)) {
            children.set(ppid, [...(children.get(ppid) ?? []), { pid, pgid }]);
        }
    }

    const found: Below[] = [];
    // A process is met once, so a listing that contradicts itself (a pid reused while it was read) cannot loop.
    const seen = new Set([root]);

    for (const queue = [root]; queue.length > 0; ) {
        for (const child of children.get(queue.shift() as number) ?? []) {
            if (!seen.has(child.pid)) {
                seen.add(child.pid);
                found.push(child);
                queue.push(child.pid);
            }
        }
    }

    return found;
}

/**
 * Signals what `below` lists that is not in the group `root` (that one is signalled whole): each group a tool made for itself, or the process alone when
 * its group's leader is not among them.
 */
export function signalBelow(below: readonly Below[], root: number, signal: NodeJS.Signals): void {
    if (process.platform === 'win32') {
        return;
    }

    const leaders = new Set(below.map(({ pid }) => pid));

    for (const { pid, pgid } of below) {
        if (pgid === root || pid <= 1) {
            continue;
        }

        try {
            process.kill(leaders.has(pgid) ? -pgid : pid, signal);
        } catch {
            // Already gone.
        }
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
    /**
     * Settles when the process has exited and its pipes are closed, so everything it wrote is read: `exited` comes at the exit, and the end of stderr can still be on its
     * way. It does not settle while something the process left holds a pipe, nor for a process that is still running: wait for it with a limit.
     */
    readonly closed: Promise<void>;
    /** The last part of what the process wrote to stderr. */
    stderr(): string;
    /**
     * Remembers the processes below this one as they stand now, so that a stop (or the process leaving) reaches the ones that left its group. Call it
     * before the process can end by itself, as a cancel begins; `stop` does it too. Safe to call again.
     */
    watch(): void;
    /** Asks the group, and what was started below it outside the group, to stop (SIGTERM), then kills them after a short grace. Safe to call again. */
    stop(): void;
}

/**
 * The end of what the process wrote to stderr, for the failure of one that is ending. The connection to an agent closes with its stdout, and its last words on stderr
 * can still be unread then, as they can at its exit, so a failure that reads `stderr()` at once can miss why the agent went. For a process that has exited or closed
 * its stdout this waits for the pipes to close, at most `STDERR_WAIT_MS`; one that is still working (an agent that answered a request with an error) is not waited for.
 */
export async function stderrOf(proc: AgentProcess): Promise<string> {
    const { child } = proc;
    const ending =
        child.exitCode !== null || child.signalCode !== null || child.stdout?.readableEnded || child.stdout?.destroyed;

    if (ending) {
        let timer: ReturnType<typeof setTimeout> | undefined;

        await Promise.race([
            proc.closed,
            new Promise<void>(resolve => {
                timer = setTimeout(resolve, STDERR_WAIT_MS);
            }),
        ]);
        clearTimeout(timer);
    }

    return proc.stderr();
}

/**
 * Starts a program as the leader of its own process group. Stopping it then stops the tools it started too (those in groups of their own
 * included, as far as `watch` and `stop` saw them), and the runtime can kill the group by the pid it was told about even after a daemon crash.
 * Rejects with the spawn error (`ENOENT` when the program is not there).
 */
export function spawnInOwnGroup({ command, args, cwd, env }: ProcessSpec): Promise<AgentProcess> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
            windowsHide: true,
        });
        let stderr = '';
        let alive = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        /** What was seen below the process, by pid: after the process leaves, its children belong to nobody, and this is all that says whose they were. */
        const below = new Map<number, Below>();
        const watch = () => {
            if (alive && child.pid !== undefined) {
                for (const found of processesBelow(child.pid)) {
                    below.set(found.pid, found);
                }
            }
        };

        // Nobody reading it would block the process once its pipe fills.
        child.stderr?.setEncoding('utf8').on('data', (text: string) => {
            stderr = (stderr + text).slice(-STDERR_TAIL_CHARS);
        });

        const exited = new Promise<void>(done => {
            child.once('exit', () => {
                alive = false;
                clearTimeout(timer);

                // Whatever the agent's tools left running goes down with it. Windows has no groups, and the tree of a pid that is gone is not worth a `taskkill`:
                // the pid may be another process's by now.
                if (child.pid !== undefined && process.platform !== 'win32') {
                    killTree(child.pid, 'SIGKILL');
                    signalBelow([...below.values()], child.pid, 'SIGKILL');
                }

                done();
            });
            child.once('error', () => done());
        });

        const closed = new Promise<void>(done => child.once('close', () => done()));

        child.once('error', reject);
        child.once('spawn', () => {
            child.off('error', reject);
            child.on('error', () => undefined);

            const pid = child.pid as number;

            resolve({
                child,
                pid,
                exited,
                closed,
                stderr: () => stderr,
                watch,
                stop() {
                    if (!alive || timer) {
                        return;
                    }

                    watch();
                    killTree(pid, 'SIGTERM');
                    signalBelow([...below.values()], pid, 'SIGTERM');
                    timer = setTimeout(() => {
                        if (alive) {
                            killTree(pid, 'SIGKILL');
                            signalBelow([...below.values()], pid, 'SIGKILL');
                        }
                    }, KILL_AFTER_MS);
                    timer.unref();
                },
            });
        });
    });
}
