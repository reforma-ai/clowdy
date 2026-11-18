import { daemonDataDir, PROTOCOL_VERSION, type DaemonInfo, type Health } from '@clowdy/protocol';
import { homedir } from 'node:os';
import path from 'node:path';

import { nodeHost, type DaemonExit, type DaemonHost } from './daemonHost';
import { parseDaemonInfo } from './daemonProbe';
import { isMinimalPath, mergePaths } from './loginShell';

import type { DesktopBridge } from '../shared/bridge';

const START_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 100;
/** After a launched daemon exits (typically because another one holds the lock), how long to wait for that other one. */
const EXIT_GRACE_MS = 3000;
const LOG_TAIL_LINES = 20;
/** How long a daemon asked to shut down may take to be gone. */
const STOP_TIMEOUT_MS = 10_000;

/** Why the app has no daemon. `details` is the dialog's second paragraph: a hint or the end of `daemon.log`. */
export class DaemonError extends Error {
    constructor(message: string, readonly details = '') {
        super(message);
    }
}

export interface DaemonContext {
    host: DaemonHost;
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    dataDir: string;
}

export function currentContext(): DaemonContext {
    const { platform, env } = process;

    return { host: nodeHost, platform, env, dataDir: daemonDataDir({ platform, home: homedir(), env }) };
}

export interface RunningDaemon {
    info: DaemonInfo;
    health: Health;
}

/** The daemon `daemon.json` names, if that very process answers its health check. A leftover file of a dead daemon yields none. */
export async function findRunning({ host, dataDir }: DaemonContext): Promise<RunningDaemon | undefined> {
    const info = parseDaemonInfo(await host.readText(path.join(dataDir, 'daemon.json')) ?? '');

    if (!info) return undefined;

    const health = await host.probe(info.port);

    return health?.pid === info.pid ? { info, health } : undefined;
}

function acceptable({ info, health }: RunningDaemon): DaemonInfo {
    if (health.protocol !== PROTOCOL_VERSION) {
        throw new DaemonError(
            `The running daemon (pid ${ info.pid }) speaks protocol ${ health.protocol }, but this app needs ${ PROTOCOL_VERSION }.`,
            'Stop that daemon (or restart it from this checkout), then start Clowdy again.'
        );
    }

    return info;
}

/** Joins a daemon the app can talk to; never starts one. The window asks this on every load, so a restarted daemon is found. */
export async function attachDaemon(context = currentContext()): Promise<DaemonInfo | undefined> {
    const running = await findRunning(context);

    return running?.health.protocol === PROTOCOL_VERSION ? running.info : undefined;
}

/** What the renderer needs to reach the daemon. */
export function daemonAddress({ port, token }: DaemonInfo): NonNullable<DesktopBridge['daemon']> {
    return { url: `http://127.0.0.1:${ port }`, token };
}

/** The last lines of a log, without the blank ones at the end. */
export function tailLines(text: string, count = LOG_TAIL_LINES): string {
    return text.trimEnd().split(/\r?\n/).slice(-count).join('\n');
}

const ELECTRON_VARIABLES = new Set(['CHROME_DESKTOP', 'CHROME_CRASHPAD_PIPE_NAME']);

/**
 * The environment of the daemon, and of the agents it starts: the app's own, minus what only makes sense inside
 * Electron (`ELECTRON_RUN_AS_NODE` would turn a child into plain Node), with the data folder pinned and, when the
 * app was started from Finder, the user's login-shell PATH, so agents find git, node, and the rest of the toolchain.
 */
export function daemonEnvironment(env: NodeJS.ProcessEnv, dataDir: string, loginPath?: string): Record<string, string> {
    const result: Record<string, string> = {};

    for (const [name, value] of Object.entries(env)) {
        const upper = name.toUpperCase();

        if (value !== undefined && !upper.startsWith('ELECTRON_') && !ELECTRON_VARIABLES.has(upper)) result[name] = value;
    }

    result.CLOWDY_DATA_DIR = dataDir;

    if (loginPath) result.PATH = mergePaths(loginPath, env.PATH);

    return result;
}

function exitReason({ code, error }: DaemonExit): string {
    return error ? `The daemon could not be started: ${ error }` : `The daemon exited with code ${ code }.`;
}

/**
 * Finds the daemon of this data folder, or starts one detached from the app (it keeps running when the app quits)
 * and waits for it. Two apps starting together end with one daemon: the daemon's own lock makes the loser exit,
 * and the loser then finds the winner. Throws `DaemonError`.
 */
export async function ensureDaemon(context = currentContext()): Promise<DaemonInfo> {
    const running = await findRunning(context);

    return running ? acceptable(running) : startDaemon(context);
}

/** Asks the daemon to shut down and waits until it is gone (its address no longer answers). Throws `DaemonError` when it stays. */
export async function stopDaemon(context: DaemonContext, { info }: RunningDaemon): Promise<void> {
    const { host } = context;
    const deadline = host.now() + STOP_TIMEOUT_MS;

    await host.stop(info);

    while (host.now() < deadline) {
        if (!await findRunning(context)) return;

        await host.sleep(POLL_INTERVAL_MS);
    }

    throw new DaemonError(`The daemon (pid ${ info.pid }) did not stop within ${ STOP_TIMEOUT_MS / 1000 } seconds.`);
}

async function startDaemon(context: DaemonContext): Promise<DaemonInfo> {
    const { host, platform, env, dataDir } = context;
    const { CLOWDY_BUN: bun, CLOWDY_DAEMON_ENTRY: entry } = env;

    if (!bun || !entry) {
        throw new DaemonError(
            'Daemon is not bundled in this build.',
            'Set CLOWDY_BUN (the bun executable) and CLOWDY_DAEMON_ENTRY (the daemon\'s main.ts) to run one from a checkout; `./clowdy dev` does.'
        );
    }

    const logPath = path.join(dataDir, 'daemon.log');
    const loginPath = platform !== 'win32' && isMinimalPath(env.PATH) ? await host.loginPath(platform, env) : undefined;
    const failure = async (message: string) => {
        const tail = tailLines(await host.readLogTail(logPath));

        return new DaemonError(message, tail && `Last lines of daemon.log:\n\n${ tail }`);
    };
    let exited: Promise<DaemonExit>;

    try {
        // The daemon's folder is the parent of the folder that holds its entry point.
        exited = host.launch({ bun, entry, cwd: path.dirname(path.dirname(entry)), env: daemonEnvironment(env, dataDir, loginPath), logPath });
    }
    catch (error) {
        throw await failure(`The daemon could not be started: ${ error instanceof Error ? error.message : String(error) }`);
    }

    let deadline = host.now() + START_TIMEOUT_MS;
    let exit: DaemonExit | undefined;

    void exited.then(result => {
        exit = result;
        // A process that never started cannot have lost the race for the lock.
        deadline = Math.min(deadline, host.now() + (result.error ? 0 : EXIT_GRACE_MS));
    });

    while (host.now() < deadline) {
        const running = await findRunning(context);

        if (running) return acceptable(running);

        await host.sleep(POLL_INTERVAL_MS);
    }

    throw await failure(exit ? exitReason(exit) : `The daemon did not answer within ${ START_TIMEOUT_MS / 1000 } seconds.`);
}
