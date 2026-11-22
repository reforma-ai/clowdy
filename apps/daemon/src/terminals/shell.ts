import { existsSync } from 'node:fs';
import { basename, win32 } from 'node:path';

import { NEVER_INHERITED } from '../engine/acp/env';
import { unavailable } from '../errors';

/** The program a terminal runs: what to execute, with which arguments, and the name a tab can be given. */
export interface Shell {
    file: string;
    args: string[];
    name: string;
}

export interface ShellLookup {
    platform?: NodeJS.Platform;
    env?: Record<string, string | undefined>;
    exists?: (file: string) => boolean;
    /** Finds a program on the `PATH`, as `Bun.which` does. */
    which?: (program: string) => string | null;
}

const nameOf = (file: string) => (file.includes('\\') ? win32.basename(file) : basename(file)).replace(/\.(exe|cmd|bat)$/i, '');

/**
 * The person's own shell, as a terminal app starts it.
 * - macOS and Linux: `$SHELL`, else zsh (macOS) or bash, else sh. macOS terminals run a login shell, which is what reads `.zprofile`, where Homebrew puts
 *   its `PATH`; on Linux a terminal is a plain interactive shell, which reads `.bashrc`.
 * - Windows: PowerShell 7 when it is installed, else Windows PowerShell, else `%ComSpec%`.
 */
export function resolveShell({ platform = process.platform, env = process.env, exists = existsSync, which = Bun.which }: ShellLookup = {}): Shell {
    if (platform === 'win32') {
        const pwsh = which('pwsh') ?? which('powershell');

        if (pwsh) {
            return { file: pwsh, args: ['-NoLogo'], name: nameOf(pwsh) };
        }

        const file = env.ComSpec || env.COMSPEC || 'cmd.exe';

        return { file, args: [], name: nameOf(file) };
    }

    const candidates = [env.SHELL, platform === 'darwin' ? '/bin/zsh' : '/bin/bash', '/bin/bash', '/bin/sh'];
    const file = candidates.find((candidate): candidate is string => typeof candidate === 'string' && candidate.startsWith('/') && exists(candidate));

    if (!file) {
        throw unavailable('No shell to run: $SHELL names none that exists, and /bin/zsh, /bin/bash and /bin/sh are not here');
    }

    return { file, args: platform === 'darwin' ? ['-l'] : [], name: nameOf(file) };
}

/**
 * The daemon's environment (the app already merged the login `PATH` into it) without what an agent never inherits either (the daemon's settings and token, the
 * markers of the app that started it, `CLAUDECODE`, which would make a Claude Code in the terminal a sub-session), with what tells a program it is in a terminal that
 * draws colors.
 */
export function terminalEnvironment(env: Record<string, string | undefined> = process.env): Record<string, string> {
    const result: Record<string, string> = {};

    for (const [name, value] of Object.entries(env)) {
        if (value !== undefined && !NEVER_INHERITED.some(pattern => pattern.test(name))) {
            result[name] = value;
        }
    }

    return { ...result, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Clowdy' };
}
