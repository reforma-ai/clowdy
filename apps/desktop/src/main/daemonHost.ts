import { PROTOCOL_HEADER, PROTOCOL_VERSION, ROUTES, type DaemonInfo, type Health } from '@clowdy/protocol';
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';

import { probeHealth } from './daemonProbe';
import { loginShellPath } from './loginShell';

export const HEALTH_TIMEOUT_MS = 800;

/** How much of the end of `daemon.log` is read for an error report. */
const LOG_TAIL_BYTES = 16 * 1024;

export interface DaemonLaunch {
    /** The bun executable. */
    bun: string;
    /** The daemon's `main.ts`. */
    entry: string;
    cwd: string;
    env: Record<string, string>;
    /** Opened for append; the daemon's output goes here. */
    logPath: string;
}

/** How a launched daemon process ended. `error` is set when it could not be started at all. */
export interface DaemonExit {
    code: number | null;
    error?: string;
}

/** Everything `ensureDaemon` needs from the machine, so tests can replace it. */
export interface DaemonHost {
    /** The text of a file, or `undefined` when it cannot be read. */
    readText(file: string): Promise<string | undefined>;
    /** The end of a log file; empty when there is none. */
    readLogTail(file: string): Promise<string>;
    probe(port: number): Promise<Health | undefined>;
    /** Starts the daemon detached from the app, so it survives the app. Settles when that process ends. */
    launch(launch: DaemonLaunch): Promise<DaemonExit>;
    /** Asks the daemon to shut down gracefully. Does not wait for it to end; a daemon that cannot be reached is taken as stopped. */
    stop(info: DaemonInfo): Promise<void>;
    /** The user's login-shell PATH, or `undefined` when it cannot be had. */
    loginPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Promise<string | undefined>;
    sleep(ms: number): Promise<void>;
    now(): number;
}

async function readLogTail(file: string): Promise<string> {
    try {
        const handle = await open(file, 'r');

        try {
            const { size } = await handle.stat();
            const length = Math.min(size, LOG_TAIL_BYTES);
            const buffer = Buffer.alloc(length);

            await handle.read(buffer, 0, length, size - length);

            return buffer.toString('utf8');
        }
        finally {
            await handle.close();
        }
    }
    catch {
        return '';
    }
}

function launch({ bun, entry, cwd, env, logPath }: DaemonLaunch): Promise<DaemonExit> {
    mkdirSync(path.dirname(logPath), { recursive: true });

    const log = openSync(logPath, 'a');

    try {
        writeSync(log, `\n--- ${ new Date().toISOString() } Clowdy starts the daemon: ${ bun } ${ entry }\n`);

        // A process of its own (setsid on POSIX), hidden on Windows, with no handle that keeps the app alive.
        const child = spawn(bun, [entry], { cwd, env, detached: true, stdio: ['ignore', log, log], windowsHide: true });

        child.unref();

        return new Promise(resolve => {
            child.once('error', error => resolve({ code: null, error: error.message }));
            child.once('exit', code => resolve({ code }));
        });
    }
    finally {
        closeSync(log);
    }
}

async function stop({ port, token }: DaemonInfo): Promise<void> {
    await fetch(`http://127.0.0.1:${ port }${ ROUTES.shutdown }`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ token }`, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS * 5),
    }).catch(() => undefined);
}

export const nodeHost: DaemonHost = {
    readText: file => readFile(file, 'utf8').catch(() => undefined),
    readLogTail,
    probe: port => probeHealth(port, HEALTH_TIMEOUT_MS),
    launch,
    stop,
    loginPath: loginShellPath,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(),
};
