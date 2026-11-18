/**
 * The `./clowdy` command line.
 *
 *   ./clowdy dev [electron args]   Run the desktop app, rebuilding and reloading as you edit.
 *   ./clowdy build [mac|win]       Build the unpacked desktop app for an OS (default: this one).
 *   ./clowdy worktree add|remove   Extra checkout for work that should not share this branch.
 *
 * `bun run clowdy <command>` does the same where `./clowdy` cannot run, such as Windows.
 */
import path from 'node:path';

import { worktreeCommand } from './worktree';

const root = path.resolve(import.meta.dir, '..');
const [command, ...args] = process.argv.slice(2);

const HELP = `Usage: ./clowdy <command>

Commands:
  dev [electron args]   Run the desktop app; the renderer is rebuilt and the window reloads as you edit, main and preload restart the app
  build [mac|win]       Build the unpacked desktop app into apps/desktop/release (default: this OS; mac needs a Mac)
  worktree add <slug>   New checkout at ../clowdy-<slug> on <nickname>/<slug> from origin/main
  worktree remove <slug>  Remove that checkout. Refuses uncommitted work
  help                  Show this help

Examples:
  ./clowdy dev
  ./clowdy build
  ./clowdy build win
  ./clowdy worktree add auth-refresh
`;

switch (command) {
    case 'dev':
        await run('dev', args);
        break;
    case 'build':
        await build(args);
        break;
    case 'worktree':
        await worktreeCommand(root, args);
        break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
        console.log(HELP);
        break;
    default:
        console.error(`Unknown command: ${ command }\n`);
        console.error(HELP);
        process.exit(1);
}

async function build([os, ...rest]: string[]): Promise<void> {
    const target = os ?? (process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : undefined);

    if ((target !== 'mac' && target !== 'win') || rest.length > 0) {
        console.error('Usage: ./clowdy build [mac|win]');
        process.exit(1);
    }

    // electron-builder builds macOS apps only on a Mac; Windows apps build anywhere.
    if (target === 'mac' && process.platform !== 'darwin') {
        console.error('A macOS build needs a Mac. `./clowdy build win` works here.');
        process.exit(1);
    }

    await run(target === 'mac' ? 'package' : 'package:win', []);
}

/** Runs a script of `apps/desktop` in the foreground and exits with its code. */
async function run(script: string, args: string[]): Promise<void> {
    const child = Bun.spawn(['bun', 'run', script, ...args], {
        cwd: path.join(root, 'apps/desktop'),
        stdio: ['inherit', 'inherit', 'inherit'],
    });

    // The child shuts itself down on a signal; this waits for it and exits with its code.
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));

    process.exit(await child.exited);
}
