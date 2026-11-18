import { PROTOCOL_VERSION, type Health } from '@clowdy/protocol';
import { describe, expect, test } from 'vitest';

import { attachDaemon, daemonAddress, daemonEnvironment, DaemonError, ensureDaemon, tailLines, type DaemonContext } from './daemon';

import type { DaemonExit, DaemonHost, DaemonLaunch } from './daemonHost';

const DATA_DIR = '/data/daemon';
const INFO_FILE = `${ DATA_DIR }/daemon.json`;
const LOG_FILE = `${ DATA_DIR }/daemon.log`;
const INFO = { pid: 4242, port: 51000, token: 'secret', protocol: PROTOCOL_VERSION, startedAt: 1_700_000_000_000 };

const healthOf = (info = INFO, overrides: Partial<Health> = {}): Health => ({ ok: true, protocol: info.protocol, version: '0.0.1', pid: info.pid, startedAt: info.startedAt, ...overrides });

interface World {
    files: Map<string, string>;
    /** What answers on a port once the fake clock reaches `readyAt`. */
    daemons: Map<number, { health: Health; readyAt: number }>;
    launches: DaemonLaunch[];
    logins: number;
    /** Fake milliseconds; only `sleep` moves it. */
    clock: number;
}

/** Starts a daemon the way the real one does: `daemon.json` first, then it answers `delay` fake milliseconds later. */
function publish(world: World, info = INFO, delay = 0): void {
    world.files.set(INFO_FILE, JSON.stringify(info));
    world.daemons.set(info.port, { health: healthOf(info), readyAt: world.clock + delay });
}

/**
 * A machine in memory. `onLaunch` plays the daemon process: it may publish a daemon and returns how the process exits.
 * Without it the launched process runs forever and never answers.
 */
function setup(options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    files?: Record<string, string>;
    running?: typeof INFO;
    loginPath?: string;
    onLaunch?: (world: World) => Promise<DaemonExit> | void;
    launchError?: Error;
} = {}) {
    const world: World = { files: new Map(Object.entries(options.files ?? {})), daemons: new Map(), launches: [], logins: 0, clock: 0 };

    if (options.running) publish(world, options.running);

    const host: DaemonHost = {
        readText: async file => world.files.get(file),
        readLogTail: async file => world.files.get(file) ?? '',
        probe: async port => {
            const daemon = world.daemons.get(port);

            return daemon && world.clock >= daemon.readyAt ? daemon.health : undefined;
        },
        launch(launch) {
            if (options.launchError) throw options.launchError;

            world.launches.push(launch);

            return options.onLaunch?.(world) ?? new Promise<DaemonExit>(() => undefined);
        },
        stop: async ({ port }) => {
            world.daemons.delete(port);
            world.files.delete(INFO_FILE);
        },
        loginPath: async () => {
            world.logins += 1;

            return options.loginPath;
        },
        sleep: async ms => {
            world.clock += ms;
        },
        now: () => world.clock,
    };
    const context: DaemonContext = {
        host,
        platform: options.platform ?? 'darwin',
        env: { PATH: '/opt/bin:/usr/bin', CLOWDY_BUN: '/usr/local/bin/bun', CLOWDY_DAEMON_ENTRY: '/repo/apps/daemon/src/main.ts', ...options.env },
        dataDir: DATA_DIR,
    };

    return { world, context };
}

async function failureOf(promise: Promise<unknown>): Promise<DaemonError> {
    const error = await promise.then(() => undefined, (reason: unknown) => reason);

    expect(error).toBeInstanceOf(DaemonError);

    return error as DaemonError;
}

describe('ensureDaemon: attach or start', () => {
    test('attaches to a daemon that answers, and starts nothing', async () => {
        const { world, context } = setup({ running: INFO });

        expect(await ensureDaemon(context)).toEqual(INFO);
        expect(world.launches).toEqual([]);
    });

    test('starts the daemon when there is no daemon.json', async () => {
        const { world, context } = setup({ onLaunch: state => void publish(state) });

        expect(await ensureDaemon(context)).toEqual(INFO);
        expect(world.launches).toHaveLength(1);
    });

    test('replaces a stale daemon.json whose process is gone', async () => {
        const fresh = { ...INFO, pid: 9999, port: 52000 };
        const { world, context } = setup({ files: { [INFO_FILE]: JSON.stringify(INFO) }, onLaunch: state => void publish(state, fresh) });

        expect(await ensureDaemon(context)).toEqual(fresh);
        expect(world.launches).toHaveLength(1);
    });

    test('does not trust another service on the stale port: the health answer must name the pid', async () => {
        const stranger = setup({ onLaunch: state => void publish(state, { ...INFO, pid: 9999, port: 52000 }) });

        stranger.world.files.set(INFO_FILE, JSON.stringify(INFO));
        stranger.world.daemons.set(INFO.port, { health: healthOf(INFO, { pid: 1 }), readyAt: 0 });

        expect((await ensureDaemon(stranger.context)).pid).toBe(9999);
        expect(stranger.world.launches).toHaveLength(1);
    });

    test('treats a damaged daemon.json as none', async () => {
        const { world, context } = setup({ files: { [INFO_FILE]: '{"pid":' }, onLaunch: state => void publish(state) });

        expect(await ensureDaemon(context)).toEqual(INFO);
        expect(world.launches).toHaveLength(1);
    });

    test('refuses a running daemon of another protocol major, and does not start a second one', async () => {
        const { world, context } = setup({ running: { ...INFO, protocol: PROTOCOL_VERSION + 1 } });
        const error = await failureOf(ensureDaemon(context));

        expect(error.message).toContain(`speaks protocol ${ PROTOCOL_VERSION + 1 }`);
        expect(world.launches).toEqual([]);
    });

    test('waits for the daemon to come up', async () => {
        const { world, context } = setup({ onLaunch: state => void publish(state, INFO, 2500) });

        expect(await ensureDaemon(context)).toEqual(INFO);
        expect(world.clock).toBeGreaterThanOrEqual(2500);
        expect(world.clock).toBeLessThan(2700);
    });
});

describe('ensureDaemon: how the daemon is started', () => {
    test('runs bun on the entry from the daemon\'s folder, logging to daemon.log in the data folder', async () => {
        const { world, context } = setup({ onLaunch: state => void publish(state) });

        await ensureDaemon(context);

        expect(world.launches[0]).toMatchObject({
            bun: '/usr/local/bin/bun',
            entry: '/repo/apps/daemon/src/main.ts',
            cwd: '/repo/apps/daemon',
            logPath: LOG_FILE,
        });
    });

    test('pins the data folder the app computed, so both sides use the same one', async () => {
        const { world, context } = setup({ env: { CLOWDY_DATA_DIR: '/elsewhere' }, onLaunch: state => void publish(state) });

        await ensureDaemon(context);

        expect(world.launches[0].env.CLOWDY_DATA_DIR).toBe(DATA_DIR);
    });

    test('says so when no daemon is bundled', async () => {
        for (const env of [{ CLOWDY_BUN: '' }, { CLOWDY_DAEMON_ENTRY: '' }]) {
            const { world, context } = setup({ env });
            const error = await failureOf(ensureDaemon(context));

            expect(error.message).toBe('Daemon is not bundled in this build.');
            expect(world.launches).toEqual([]);
        }
    });

    test('resolves the login-shell PATH only for an app started from Finder', async () => {
        const finder = setup({ env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, loginPath: '/opt/homebrew/bin:/usr/bin:/bin', onLaunch: state => void publish(state) });

        await ensureDaemon(finder.context);

        expect(finder.world.logins).toBe(1);
        expect(finder.world.launches[0].env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin');

        const terminal = setup({ loginPath: '/never', onLaunch: state => void publish(state) });

        await ensureDaemon(terminal.context);

        expect(terminal.world.logins).toBe(0);
        expect(terminal.world.launches[0].env.PATH).toBe('/opt/bin:/usr/bin');
    });

    test('keeps the app\'s PATH when the login shell gives none', async () => {
        const { world, context } = setup({ env: { PATH: '/usr/bin:/bin' }, onLaunch: state => void publish(state) });

        await ensureDaemon(context);

        expect(world.logins).toBe(1);
        expect(world.launches[0].env.PATH).toBe('/usr/bin:/bin');
    });

    test('does not ask a login shell on Windows', async () => {
        const { world, context } = setup({ platform: 'win32', env: { PATH: '' }, onLaunch: state => void publish(state) });

        await ensureDaemon(context);

        expect(world.logins).toBe(0);
    });
});

describe('ensureDaemon: failures and races', () => {
    test('another daemon winning the lock: our process exits and we attach to the winner', async () => {
        const { world, context } = setup({
            // The winner is still starting (answers after 1 s); our own process exits at once, as on "already running".
            onLaunch: state => {
                publish(state, INFO, 1000);

                return Promise.resolve({ code: 1 });
            },
        });

        expect(await ensureDaemon(context)).toEqual(INFO);
        expect(world.launches).toHaveLength(1);
    });

    test('a daemon that exits for good ends with the end of its log', async () => {
        const lines = Array.from({ length: 30 }, (_value, index) => `line ${ index + 1 }`).join('\n');
        const { world, context } = setup({ files: { [LOG_FILE]: `${ lines }\n` }, onLaunch: () => Promise.resolve({ code: 1 }) });
        const error = await failureOf(ensureDaemon(context));

        expect(error.message).toBe('The daemon exited with code 1.');
        expect(error.details).toContain('Last lines of daemon.log');
        expect(error.details).toContain('line 30');
        expect(error.details).toContain('line 11');
        expect(error.details).not.toContain('line 10\n');
        // Only the grace period for a winner, not the whole timeout.
        expect(world.clock).toBeLessThan(5000);
    });

    test('a bun that cannot be started is reported with the reason, without waiting for a winner', async () => {
        const { world, context } = setup({ onLaunch: () => Promise.resolve({ code: null, error: 'spawn /usr/local/bin/bun ENOENT' }) });

        expect((await failureOf(ensureDaemon(context))).message).toBe('The daemon could not be started: spawn /usr/local/bin/bun ENOENT');
        expect(world.clock).toBeLessThan(500);
    });

    test('a launch that throws is reported', async () => {
        const { context } = setup({ launchError: new Error('EACCES: permission denied, open daemon.log') });

        expect((await failureOf(ensureDaemon(context))).message).toContain('EACCES');
    });

    test('a daemon that never answers fails after 15 seconds', async () => {
        const { world, context } = setup({ files: { [LOG_FILE]: 'starting...\n' } });
        const error = await failureOf(ensureDaemon(context));

        expect(error.message).toBe('The daemon did not answer within 15 seconds.');
        expect(error.details).toContain('starting...');
        expect(world.clock).toBeGreaterThanOrEqual(15_000);
        expect(world.clock).toBeLessThan(15_500);
    });

    test('an empty log leaves no empty section in the report', async () => {
        const { context } = setup({ onLaunch: () => Promise.resolve({ code: 1 }) });

        expect((await failureOf(ensureDaemon(context))).details).toBe('');
    });
});

describe('attachDaemon', () => {
    test('finds a running daemon of this protocol', async () => {
        const { world, context } = setup({ running: INFO });

        expect(await attachDaemon(context)).toEqual(INFO);
        expect(world.launches).toEqual([]);
    });

    test('never starts a daemon, and finds none of another protocol', async () => {
        const nothing = setup();
        const other = setup({ running: { ...INFO, protocol: PROTOCOL_VERSION + 1 } });

        expect(await attachDaemon(nothing.context)).toBeUndefined();
        expect(await attachDaemon(other.context)).toBeUndefined();
        expect(nothing.world.launches).toEqual([]);
    });
});

describe('daemonEnvironment', () => {
    test('removes what only makes sense inside Electron and keeps the rest', () => {
        const env = daemonEnvironment({
            ELECTRON_RUN_AS_NODE: '1',
            electron_no_attach_console: '1',
            CHROME_DESKTOP: 'clowdy.desktop',
            CHROME_PATH: '/Applications/Chrome',
            HOME: '/Users/a',
            LANG: 'en_US.UTF-8',
            UNSET: undefined,
        }, DATA_DIR);

        expect(env).toEqual({ CHROME_PATH: '/Applications/Chrome', HOME: '/Users/a', LANG: 'en_US.UTF-8', CLOWDY_DATA_DIR: DATA_DIR });
    });

    test('puts the login-shell PATH in front of the app\'s', () => {
        expect(daemonEnvironment({ PATH: '/usr/bin' }, DATA_DIR, '/opt/homebrew/bin:/usr/bin').PATH).toBe('/opt/homebrew/bin:/usr/bin');
    });
});

describe('helpers', () => {
    test('tailLines keeps the last lines and drops trailing blank ones', () => {
        expect(tailLines('a\nb\nc\n\n', 2)).toBe('b\nc');
        expect(tailLines('a\r\nb\r\n', 5)).toBe('a\nb');
        expect(tailLines('')).toBe('');
    });

    test('daemonAddress is a loopback URL and the token', () => {
        expect(daemonAddress(INFO)).toEqual({ url: 'http://127.0.0.1:51000', token: 'secret' });
    });
});
