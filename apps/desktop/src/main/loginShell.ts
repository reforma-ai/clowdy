import { spawn } from 'node:child_process';
import { delimiter } from 'node:path';

const MARKER = '__CLOWDY_PATH__';

/** Prints the PATH between markers, so whatever the user's shell startup files print does not end up in it. */
const PRINT_PATH = `printf '%s%s%s' ${ MARKER } "$PATH" ${ MARKER }`;

/** What launchd gives an app started from Finder or the Dock. */
const SYSTEM_DIRECTORIES = new Set(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);

export const LOGIN_SHELL_TIMEOUT_MS = 3000;

/** The PATH a shell printed with `PRINT_PATH`, or `undefined` when the output has none. */
export function parseLoginShellPath(output: string): string | undefined {
    const start = output.indexOf(MARKER);
    const end = output.indexOf(MARKER, start + MARKER.length);

    if (start === -1 || end === -1) return undefined;

    const value = output.slice(start + MARKER.length, end);

    return value === '' || /[\r\n]/.test(value) ? undefined : value;
}

/** True for the bare system PATH of an app that was started from Finder, which lacks the user's tools. */
export function isMinimalPath(path: string | undefined, separator = delimiter): boolean {
    const entries = (path ?? '').split(separator).filter(Boolean);

    return entries.every(entry => SYSTEM_DIRECTORIES.has(entry));
}

/** The login shell's entries first, then the current ones it does not have, without duplicates. */
export function mergePaths(loginPath: string, currentPath: string | undefined, separator = delimiter): string {
    const entries = [...loginPath.split(separator), ...(currentPath ?? '').split(separator)].filter(Boolean);

    return [...new Set(entries)].join(separator);
}

/** Runs `shell -ilc 'printf %s "$PATH"'`. Resolves `undefined` when the shell fails or takes longer than the timeout. */
export function resolveLoginShellPath(shell: string, env: NodeJS.ProcessEnv, timeoutMs = LOGIN_SHELL_TIMEOUT_MS): Promise<string | undefined> {
    return new Promise(resolve => {
        // No input for the interactive shell, and its complaints about the missing terminal go nowhere.
        const child = spawn(shell, ['-ilc', PRINT_PATH], { env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        const finish = (path: string | undefined) => {
            clearTimeout(timer);
            resolve(path);
        };
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            child.stdout.destroy();
            finish(undefined);
        }, timeoutMs);
        let output = '';

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => output += chunk);
        child.once('error', () => finish(undefined));
        child.once('close', () => finish(parseLoginShellPath(output)));
    });
}

let cached: Promise<string | undefined> | undefined;

/** The user's login-shell PATH, resolved once per run: starting an interactive shell takes up to seconds. */
export function loginShellPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Promise<string | undefined> {
    const shell = env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh');

    return cached ??= resolveLoginShellPath(shell, env);
}
