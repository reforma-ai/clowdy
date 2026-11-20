/**
 * The `clowdy` command an agent finds on its `PATH`: a small script in the daemon's data folder that runs the CLI (`clowdy.ts`) with the daemon's own
 * Bun. It cannot live in `clowdy.ts`: that file runs in the agent's shell, this one in the daemon, which writes the script at every start, so a moved
 * app or a new Bun is picked up by the next start.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { errorMessage } from '../errors';

/**
 * The program the command runs. It sits beside the module that runs this line: `clowdy.ts` next to this file in the sources, `clowdy.js` next to
 * `main.js` in a bundle (`scripts/bundle.ts`), so its extension is this module's, as `bridge.ts` finds `mcp-stdio`.
 */
export const CLI_ENTRY = fileURLToPath(new URL(`./clowdy${ extname(fileURLToPath(import.meta.url)) }`, import.meta.url));

/** Where the command is: what the daemon gives each agent process that may use it. */
export interface Shim {
    /** The folder that holds the command, put first on the agent's `PATH`. */
    dir: string;
    /** The command's absolute path, given to the agent as `CLOWDY_CLI` for a shell whose `PATH` was rewritten. */
    command: string;
}

export interface ShimOptions {
    /** The Bun that runs the CLI; the daemon's own. */
    runtime?: string;
    /** The CLI's entry; `CLI_ENTRY`. */
    entry?: string;
    platform?: NodeJS.Platform;
}

/** A word for `sh`: single quotes keep spaces, `$` and double quotes as they are; a single quote is closed, escaped and opened again. */
const shQuote = (text: string) => `'${ text.replaceAll('\'', '\'\\\'\'') }'`;

/** A word for `cmd.exe`: Windows paths have no double quotes, and a `%` in a batch file is written twice. */
const cmdQuote = (text: string) => `"${ text.replaceAll('%', '%%') }"`;

/**
 * The arguments Bun gets before the entry. The command runs in the agent's working folder, a project's, so Bun would read that project's `bunfig.toml`
 * (a `preload` would run the project's code inside the CLI) and its `.env` files; an empty config of the daemon's own and `--no-env-file` keep both out.
 */
const runtimeFlags = (config: string, quote: (text: string) => string) => ['--no-env-file', quote(`--config=${ config }`)];

/** Writes `file` with `content` when it differs, by a rename so that a shell that runs the old one meanwhile never reads half a file, and sets its mode. */
function writeIfChanged(file: string, content: string, mode?: number): void {
    const same = existsSync(file) && readFileSync(file, 'utf8') === content;

    if (!same) {
        const temp = `${ file }.${ process.pid }.tmp`;

        writeFileSync(temp, content, mode === undefined ? undefined : { mode });
        renameSync(temp, file);
    }

    if (mode !== undefined && (statSync(file).mode & 0o777) !== mode) {
        chmodSync(file, mode);
    }
}

/**
 * Writes `<dataDir>/bin/clowdy` (a POSIX `sh` script, mode 0755) and, on Windows, `clowdy.cmd` beside it, each only when its content changed, and
 * answers where the command is. Paths with spaces and quotes work (the macOS data folder is under `Application Support`).
 */
export function installShim(dataDir: string, { runtime = process.execPath, entry = CLI_ENTRY, platform = process.platform }: ShimOptions = {}): Shim {
    const dir = join(dataDir, 'bin');
    const config = join(dir, 'bunfig.toml');
    const header = 'The clowdy command of the Clowdy daemon, written again at every start: do not edit';

    mkdirSync(dir, { recursive: true });
    writeIfChanged(config, '');
    writeIfChanged(join(dir, 'clowdy'), [
        '#!/bin/sh',
        `# ${ header }`,
        `exec ${ [shQuote(runtime), ...runtimeFlags(config, shQuote), shQuote(entry)].join(' ') } "$@"`,
        '',
    ].join('\n'), 0o755);

    if (platform !== 'win32') {
        return { dir, command: join(dir, 'clowdy') };
    }

    writeIfChanged(join(dir, 'clowdy.cmd'), [
        '@echo off',
        `rem ${ header }`,
        `${ [cmdQuote(runtime), ...runtimeFlags(config, cmdQuote), cmdQuote(entry)].join(' ') } %*`,
        '',
    ].join('\r\n'));

    return { dir, command: join(dir, 'clowdy.cmd') };
}

/** `installShim` at the daemon's start: a folder it cannot write is no reason to refuse to start, so its agents then go without the command. */
export function installShimOrWarn(dataDir: string): Shim | undefined {
    try {
        return installShim(dataDir);
    }
    catch (error) {
        console.warn(`[clowdy] the clowdy command could not be written, so agents cannot use threads: ${ errorMessage(error) }`);

        return undefined;
    }
}
