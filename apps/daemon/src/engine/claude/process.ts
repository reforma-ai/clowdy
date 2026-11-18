import { spawn } from 'node:child_process';

import { killProcessGroup } from '../process';

import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

/** After a polite stop, the group gets this long before it is killed outright. */
const KILL_AFTER_MS = 2000;

export interface SpawnHooks {
    /** Called once the process exists: its pid (also its group id), and a promise that settles when it has exited. */
    onSpawn(pid: number, exited: Promise<void>): void;
    /** Everything the process writes to stderr. Nobody reading it would block the process once its pipe fills. */
    onStderr(text: string): void;
}

/**
 * The SDK's `spawnClaudeCodeProcess` that makes `claude` the leader of its own process group. Stopping it then stops
 * the tools it started too, and the runtime can kill the group by the pid it was told about even after a daemon crash.
 */
export function spawnInOwnGroup({ onSpawn, onStderr }: SpawnHooks): (options: SpawnOptions) => SpawnedProcess {
    return ({ command, args, cwd, env, signal }) => {
        const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
        const { pid } = child;

        child.stderr?.setEncoding('utf8').on('data', onStderr);

        if (pid === undefined) {
            return child;
        }

        // `kill` on a ChildProcess reaches only the leader.
        child.kill = (how = 'SIGTERM') => {
            killProcessGroup(pid, how as NodeJS.Signals);

            return true;
        };

        const stop = () => {
            child.kill('SIGTERM');
            setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null) {
                    child.kill('SIGKILL');
                }
            }, KILL_AFTER_MS).unref();
        };

        if (signal.aborted) {
            stop();
        }
        else {
            signal.addEventListener('abort', stop, { once: true });
        }

        // Whatever the agent's tools left running goes down with it.
        child.once('exit', () => killProcessGroup(pid, 'SIGKILL'));
        onSpawn(pid, new Promise<void>(resolve => child.once('exit', () => resolve())));

        return child;
    };
}
