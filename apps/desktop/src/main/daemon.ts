import { homedir } from 'node:os';
import path from 'node:path';
import { type DaemonInfo, daemonDataDir, type Health, PROTOCOL_VERSION } from '@clowdy/protocol';

import { type DaemonExit, type DaemonHost, nodeHost } from './daemonHost';
import { parseDaemonInfo } from './daemonProbe';
import { isMinimalPath, mergePaths } from './loginShell';

import type { DesktopBridge } from '../shared/bridge';

const START_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 100;
/** After a launched daemon exits (typically because another one holds the lock), how long to wait for that other one. */
const EXIT_GRACE_MS = 3000;
const LOG_TAIL_LINES = 20;
/**
 * How long a daemon asked to shut down may take to be gone. One stopped with runs in progress gives them 10 s to settle
 * and each agent process left over 5 s more to end (`RunDriver.stop` in `apps/daemon`).
 */
const STOP_TIMEOUT_MS = 30_000;

/** Why the app has no daemon. `details` is the dialog's second paragraph: a hint or the end of `daemon.log`. */
export class DaemonError extends Error {
    constructor(
        message: string,
        readonly details = ''
    ) {
        super(message);
    }
}

/** What runs the daemon: a packaged app's copies (`bundle.ts`), or a development run's checkout. */
export interface DaemonRuntime {
    /** The bun executable. */
    bun: string;
    /** The daemon's entry: `main.js` of a bundle, `src/main.ts` of a checkout. */
    entry: string;
    /** The system skills plugin folder, passed as `CLOWDY_SYSTEM_SKILLS_DIR`; a checkout's daemon finds its own. */
    skillsDir?: string;
    /** The ripgrep the app ships, passed as `CLOWDY_RG` for the daemon's file search; without it the daemon uses `rg` from the PATH, or searches by itself. */
    rg?: string;
}

export interface DaemonContext {
    host: DaemonHost;
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    dataDir: string;
    /** Absent when this app has no daemon to start; one already running is still found. */
    runtime?: DaemonRuntime;
}

export function currentContext(runtime?: DaemonRuntime): DaemonContext {
    const { platform, env } = process;

    return { host: nodeHost, platform, env, dataDir: daemonDataDir({ platform, home: homedir(), env }), runtime };
}

/** A development run's daemon: the Bun and the entry `./clowdy dev` names in `CLOWDY_BUN` and `CLOWDY_DAEMON_ENTRY`. */
export function environmentRuntime(env: NodeJS.ProcessEnv): DaemonRuntime | undefined {
    const { CLOWDY_BUN: bun, CLOWDY_DAEMON_ENTRY: entry } = env;

    return bun && entry ? { bun, entry } : undefined;
}

export interface RunningDaemon {
    info: DaemonInfo;
    health: Health;
}

/** The daemon `daemon.json` names, if that very process answers its health check. A leftover file of a dead daemon yields none. */
export async function findRunning({ host, dataDir }: DaemonContext): Promise<RunningDaemon | undefined> {
    const info = parseDaemonInfo((await host.readText(path.join(dataDir, 'daemon.json'))) ?? '');

    if (!info) return undefined;

    const health = await host.probe(info.port);

    return health?.pid === info.pid ? { info, health } : undefined;
}

function acceptable({ info, health }: RunningDaemon): DaemonInfo {
    if (health.protocol !== PROTOCOL_VERSION) {
        throw new DaemonError(
            `The running daemon (pid ${info.pid}) speaks protocol ${health.protocol}, but this app needs ${PROTOCOL_VERSION}.`,
            'Use the copy of Clowdy that started it, or stop that daemon and start Clowdy again.'
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
    return { url: `http://127.0.0.1:${port}`, token };
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
 * A bundled daemon is told where its system skills are, and where the ripgrep is that the app ships.
 */
export function daemonEnvironment(
    env: NodeJS.ProcessEnv,
    dataDir: string,
    loginPath?: string,
    skillsDir?: string,
    rg?: string
): Record<string, string> {
    const result: Record<string, string> = {};

    for (const [name, value] of Object.entries(env)) {
        const upper = name.toUpperCase();

        if (value !== undefined && !upper.startsWith('ELECTRON_') && !ELECTRON_VARIABLES.has(upper))
            result[name] = value;
    }

    result.CLOWDY_DATA_DIR = dataDir;

    if (skillsDir) result.CLOWDY_SYSTEM_SKILLS_DIR = skillsDir;

    if (rg) result.CLOWDY_RG = rg;

    if (loginPath) result.PATH = mergePaths(loginPath, env.PATH);

    return result;
}

function exitReason({ code, error }: DaemonExit): string {
    return error ? `The daemon could not be started: ${error}` : `The daemon exited with code ${code}.`;
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

/**
 * Asks the daemon to shut down and waits until its process has ended, or returns false while Git is busy. It stops answering first and lets go of
 * `daemon.lock` last, so a daemon started in between would find the lock taken and exit. Throws `DaemonError` when it stays.
 */
export async function stopDaemon({ host }: DaemonContext, { info }: RunningDaemon): Promise<boolean> {
    const deadline = host.now() + STOP_TIMEOUT_MS;

    if (!(await host.stop(info))) return false;

    while (host.now() < deadline) {
        if (!host.alive(info.pid)) return true;

        await host.sleep(POLL_INTERVAL_MS);
    }

    throw new DaemonError(`The daemon (pid ${info.pid}) did not stop within ${STOP_TIMEOUT_MS / 1000} seconds.`);
}

async function startDaemon(context: DaemonContext): Promise<DaemonInfo> {
    const { host, platform, env, dataDir, runtime } = context;

    if (!runtime) {
        throw new DaemonError(
            'Daemon is not bundled in this build.',
            "Set CLOWDY_BUN (the bun executable) and CLOWDY_DAEMON_ENTRY (the daemon's main.ts) to run one from a checkout; `./clowdy dev` does."
        );
    }

    const { bun, entry, skillsDir, rg } = runtime;

    const logPath = path.join(dataDir, 'daemon.log');
    const loginPath = platform !== 'win32' && isMinimalPath(env.PATH) ? await host.loginPath(platform, env) : undefined;
    const failure = async (message: string) => {
        const tail = tailLines(await host.readLogTail(logPath));

        return new DaemonError(message, tail && `Last lines of daemon.log:\n\n${tail}`);
    };
    let exited: Promise<DaemonExit>;

    try {
        // The daemon's folder is the parent of the folder that holds its entry point.
        exited = host.launch({
            bun,
            entry,
            cwd: path.dirname(path.dirname(entry)),
            env: daemonEnvironment(env, dataDir, loginPath, skillsDir, rg),
            logPath,
        });
    } catch (error) {
        throw await failure(
            `The daemon could not be started: ${error instanceof Error ? error.message : String(error)}`
        );
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

    throw await failure(
        exit ? exitReason(exit) : `The daemon did not answer within ${START_TIMEOUT_MS / 1000} seconds.`
    );
}
