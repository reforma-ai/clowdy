import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { gitLine } from '../domain/git';
import { inheritedEnv } from '../process/env';
import { runProgram } from '../process/run';

type Env = Record<string, string | undefined>;

/** What the person is told beside git's own line when the line names the signing key: the agent that holds it was not there to answer. */
export const SIGNING_HINT = "The signing agent couldn't be reached";

/**
 * Git's own words for a signature that could not be made, which is what a signed commit says when `SSH_AUTH_SOCK` is not the agent that holds the key (`No private key found
 * for public key`), when the agent will not sign (`agent refused operation`, a Touch ID that was cancelled) and when there is no agent at all.
 */
const SIGNING_FAILURE =
    /no private key found|agent refused|communication with agent failed|couldn't get agent socket|error: load key|incorrect passphrase|signing failed/i;

/** Whether what git said names the signing key: the failure `WriteEnvironment.forgetAgent` is for, and the one the hint explains. */
export function namesSigningKey(text: string): boolean {
    return SIGNING_FAILURE.test(text);
}

/** How long `ssh -G` and the login shell may take; the shell starts the person's startup files, which may be slow, and a signing agent is not worth more of the person's time. */
const SSH_TIMEOUT_MS = 5000;
const SHELL_TIMEOUT_MS = 3000;

/** Prints the socket between markers, so whatever the person's shell startup files print does not end up in it. */
const MARKER = '__CLOWDY_SOCK__';
const PRINT_SOCKET = `printf '${MARKER}%s${MARKER}' "$SSH_AUTH_SOCK"`;

export interface WriteEnvironmentOptions {
    /** The environment the daemon runs in, read at each call: the base of every write's, and the `PATH` `ssh` is looked for on. */
    env?: () => Env;
    platform?: NodeJS.Platform;
    /** What `~` is in an `IdentityAgent` path. */
    home?: string;
    sshTimeoutMs?: number;
    shellTimeoutMs?: number;
}

/**
 * The host of a remote's address, for `ssh -G` to look up: `ssh://[user@]host[:port]/...`, `git://`, `http(s)://` and the short form `[user@]host:path`. Nothing else leaves
 * the address (a credential in it, a port, the path), and nothing for a path on the disk or a name that could be taken for an option.
 */
export function remoteHost(address: string): string | undefined {
    const text = address.trim();
    const host =
        /^(?:ssh|git|https?):\/\/(?:[^@/]*@)?([^/:?#@]+)/i.exec(text)?.[1] ??
        /^(?:[^@/\s]+@)?([^/:\s@]+):(?!\/\/)/.exec(text)?.[1];

    // A single letter is a Windows drive (`C:\work`), not a host. An alias of `~/.ssh/config` may have an underscore (`github_work`); it never starts with a dash, so it cannot be an option.
    return host !== undefined && host.length > 1 && /^[a-z0-9][a-z0-9._-]*$/i.test(host)
        ? host.toLowerCase()
        : undefined;
}

/**
 * The environment of every git write the daemon makes (a commit, a fetch, a pull and a push), and the signing agent it finds for them. A write runs the person's own git with
 * their configuration, so it needs what their terminal has: no password prompt that nobody can answer (`GIT_TERMINAL_PROMPT=0`), git's own words in English, and the socket of the
 * agent that holds their signing key. An app started from Finder has launchd's socket in `SSH_AUTH_SOCK`, which has no key (a signed commit stops with `No private key found`),
 * while SSH itself works because it reads `IdentityAgent` from `~/.ssh/config`, which signing does not. So the socket is taken from `ssh -G <the host of origin>` (its `identityagent`
 * line, when it is an absolute path), else from the login shell, as the `PATH` is taken, else the inherited value stays; and what is found replaces an inherited one. It is found
 * once for each host and kept, and found again after a failure that names the signing key (`forgetAgent`). The app's own environment is never changed.
 */
export class WriteEnvironment {
    readonly #env: () => Env;
    readonly #platform: NodeJS.Platform;
    readonly #home: string;
    readonly #sshTimeoutMs: number;
    readonly #shellTimeoutMs: number;
    /** The socket `ssh -G` named for a host (`''` for a place with no origin), or none. */
    readonly #fromSsh = new Map<string, Promise<string | undefined>>();
    #fromShell: Promise<string | undefined> | undefined;

    constructor({
        env = () => process.env,
        platform = process.platform,
        home = homedir(),
        sshTimeoutMs = SSH_TIMEOUT_MS,
        shellTimeoutMs = SHELL_TIMEOUT_MS,
    }: WriteEnvironmentOptions = {}) {
        this.#env = env;
        this.#platform = platform;
        this.#home = home;
        this.#sshTimeoutMs = sshTimeoutMs;
        this.#shellTimeoutMs = shellTimeoutMs;
    }

    /** What was found of the signing agent is looked for again at the next write: a failure named the key, so what was believed is no good. */
    forgetAgent(): void {
        this.#fromSsh.clear();
        this.#fromShell = undefined;
    }

    /** The environment a git write in `cwd` runs in. `address` is the remote the write talks to when `cwd` has no `origin` to tell it (a clone, which has no repository yet). */
    async of(cwd: string, address?: string): Promise<Record<string, string>> {
        // A repository's hooks run in it.
        const base = inheritedEnv(this.#env());
        const env = { ...base, GIT_TERMINAL_PROMPT: '0', LANGUAGE: 'C' };

        // Windows' OpenSSH keeps its agent on a named pipe that git finds by itself.
        if (this.#platform === 'win32') return env;

        const socket = await this.#socketFor(cwd, base, address);

        return socket === undefined ? env : { ...env, SSH_AUTH_SOCK: socket };
    }

    async #socketFor(cwd: string, env: Record<string, string>, given?: string): Promise<string | undefined> {
        const address = given ?? (await gitLine(cwd, ['remote', 'get-url', 'origin']));
        const host = address === undefined ? '' : (remoteHost(address) ?? '');
        let asked = this.#fromSsh.get(host);

        if (!asked) {
            asked = host === '' ? Promise.resolve(undefined) : this.#askSsh(host, env);
            this.#fromSsh.set(host, asked);
        }

        const named = await asked;

        if (named !== undefined) return named;

        this.#fromShell ??= this.#askShell(env);

        return this.#fromShell;
    }

    /** The `identityagent` of `ssh -G <host>`: a socket's absolute path, not `none` and not the variable's own name (`SSH_AUTH_SOCK`, which is what is inherited). */
    async #askSsh(host: string, env: Record<string, string>): Promise<string | undefined> {
        const ssh = Bun.which('ssh', { PATH: env.PATH ?? '' });

        if (!ssh) return undefined;

        const run = await runProgram(ssh, ['-G', '--', host], { env, cwd: tmpdir(), timeoutMs: this.#sshTimeoutMs });

        if (run.code !== 0) return undefined;

        // The value is the rest of the line: the socket's folder may have a space in it (1Password's does).
        const value = /^identityagent[ \t]+(.+)$/im.exec(run.stdout)?.[1]?.trim();

        if (value === undefined || value === 'none' || value === 'SSH_AUTH_SOCK') return undefined;

        const path = value.startsWith('~/') ? join(this.#home, value.slice(2)) : value;

        return isAbsolute(path) ? path : undefined;
    }

    /** `SSH_AUTH_SOCK` of the person's login shell, which has what their startup files export. */
    async #askShell(env: Record<string, string>): Promise<string | undefined> {
        const shell = env.SHELL || (this.#platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
        const run = await runProgram(shell, ['-ilc', PRINT_SOCKET], {
            env: { ...env, TERM: 'dumb' },
            cwd: tmpdir(),
            timeoutMs: this.#shellTimeoutMs,
        });
        const value = new RegExp(`${MARKER}(.*?)${MARKER}`, 's').exec(run.stdout)?.[1];

        return value !== undefined && isAbsolute(value) && !/[\r\n]/.test(value) ? value : undefined;
    }
}
