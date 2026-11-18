import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

import { buildAgentEnv } from './env';

type Env = Record<string, string | undefined>;

const SHELL_TIMEOUT_MS = 4000;
const VERSION_TIMEOUT_MS = 5000;
const MARKER = '__CLOWDY_PATH__';

/** What `find` returns: the program that was found and the name it was found under. */
export interface Found {
    path: string;
    name: string;
}

export interface DiscoveryOptions {
    env?: Env;
    platform?: NodeJS.Platform;
    home?: string;
    /** Runs the login shell and returns its `PATH`; tests replace it. */
    loginPath?: () => Promise<string | undefined>;
    /** Folders searched after the paths above; the usual install folders by default. */
    installDirs?: string[];
}

/** Folders where agents get installed that a GUI app's `PATH` does not have. */
function installDirs(home: string): string[] {
    return [
        join(home, '.local', 'bin'),
        join(home, '.bun', 'bin'),
        join(home, '.cargo', 'bin'),
        join(home, '.npm-global', 'bin'),
        join(home, '.claude', 'local'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
    ];
}

/** Output beyond this is dropped: a startup file that chatters must not fill the daemon's memory. */
const CAPTURE_LIMIT = 64 * 1024;

/**
 * Runs a program and answers with what it printed once it has ended, or at the deadline with what it printed so far. A
 * program that leaves a process behind holding its pipes open never ends as far as `close` is concerned, and neither
 * may the daemon wait on it for ever. `undefined` when the program cannot be started.
 */
function capture(command: string, args: string[], { env, timeoutMs, stderr = false }: { env: Env; timeoutMs: number; stderr?: boolean }): Promise<string | undefined> {
    return new Promise((resolve) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', stderr ? 'pipe' : 'ignore'], env, windowsHide: true });
        let out = '';
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve(out);
        }, timeoutMs);
        const collect = (text: string) => {
            if (out.length < CAPTURE_LIMIT) {
                out += text;
            }
        };

        child.stdout?.setEncoding('utf8').on('data', collect);
        child.stderr?.setEncoding('utf8').on('data', collect);
        child.once('error', () => {
            clearTimeout(timer);
            resolve(undefined);
        });
        child.once('close', () => {
            clearTimeout(timer);
            resolve(out);
        });
    });
}

/** The `PATH` of the user's login shell. An app started from the dock has a bare one, and agents live in what the shell adds. */
export async function readLoginPath(env: Env, timeoutMs = SHELL_TIMEOUT_MS): Promise<string | undefined> {
    const out = await capture(env.SHELL || '/bin/zsh', ['-ilc', `printf '${ MARKER }%s${ MARKER }' "$PATH"`], { env: { ...env, TERM: 'dumb' }, timeoutMs });

    return out === undefined ? undefined : new RegExp(`${ MARKER }(.*?)${ MARKER }`, 's').exec(out)?.[1] || undefined;
}

/**
 * Finds programs the way the user's terminal would: the login shell's `PATH` (read once), the daemon's own, and the usual
 * install folders. It answers "is this agent installed here, where, and which version" and nothing more.
 */
export class Discovery {
    private env: Env;
    private platform: NodeJS.Platform;
    private home: string;
    private readLogin: () => Promise<string | undefined>;
    private extraDirs: string[];
    private dirsPromise?: Promise<string[]>;

    constructor(options: DiscoveryOptions = {}) {
        this.env = options.env ?? process.env;
        this.platform = options.platform ?? process.platform;
        this.home = options.home ?? homedir();
        this.readLogin = options.loginPath ?? (() => readLoginPath(this.env));
        this.extraDirs = options.installDirs ?? installDirs(this.home);
    }

    /** The folders searched, in order, without repeats. */
    dirs(): Promise<string[]> {
        this.dirsPromise ??= (async () => {
            const login = this.platform === 'win32' ? undefined : await this.readLogin().catch(() => undefined);
            const all = [login, this.env.PATH, this.extraDirs.join(delimiter)].flatMap(path => path?.split(delimiter) ?? []);

            return [...new Set(all.filter(Boolean))];
        })();

        return this.dirsPromise;
    }

    /** The search path as a string, for the environment of an agent. */
    async path(): Promise<string> {
        return (await this.dirs()).join(delimiter);
    }

    /** The first of `names` that exists as a program. A name with a path separator is checked as it is. */
    async find(names: string[]): Promise<Found | undefined> {
        const PATH = await this.path();

        for (const name of names) {
            const path = Bun.which(name, { PATH });

            if (path) {
                return { path, name };
            }
        }

        return undefined;
    }

    /** Forgets the cached search path, for when the user installed something and asks to look again. */
    refresh(): void {
        this.dirsPromise = undefined;
    }

    /** What `<program> --version` prints as a version, or `undefined` when it prints nothing usable in time. */
    async version(program: string): Promise<string | undefined> {
        // The program is the user's, possibly one they pointed us at by hand: it gets what an agent gets, not the daemon's secrets.
        const out = await capture(program, ['--version'], { env: buildAgentEnv({ daemonEnv: this.env, path: await this.path() }), timeoutMs: VERSION_TIMEOUT_MS, stderr: true });

        return out === undefined ? undefined : parseVersion(out);
    }
}

/** `2.1.325 (Claude Code)` is `2.1.325`; `2026.09.01-abcdef` is itself; a line of prose is cut short. */
export function parseVersion(output: string): string | undefined {
    const line = output.split('\n').map(text => text.trim()).find(Boolean);

    if (!line) {
        return undefined;
    }

    return /\bv?(\d+(?:\.\d+)+(?:[-+][\w.]+)?)/.exec(line)?.[1] ?? line.slice(0, 40);
}
