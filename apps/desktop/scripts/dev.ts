/**
 * `bun run dev`: the app with hot module replacement.
 *
 * - The renderer is a Vite dev server, so edits to React, CSS, and the design system packages reach the
 *   open window without a reload.
 * - Main and preload are bundled with Bun. A change under `src/main`, `src/preload`, or `src/shared`
 *   rebuilds them and restarts the app; so does the next save after the app crashed.
 * - Quitting the app ends the session.
 * - The app finds or starts the daemon from this checkout (`apps/daemon`) and leaves it running. Nothing here watches
 *   the daemon's sources: agents edit them while it runs, and the person restarts it deliberately.
 *
 * `CLOWDY_RENDERER_PORT` moves the dev server off 5273. Arguments go to Electron.
 */
import { daemonDataDir } from '@clowdy/protocol';
import { $, type Subprocess } from 'bun';
import { readFileSync, watch } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';

import { buildMain } from './main-bundle';

// Outside Electron, the `electron` package exports the path to its binary (downloaded on first use).
const electronBinary = (await import('electron')).default as unknown as string;

const desktopRoot = path.resolve(import.meta.dir, '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const port = Number(process.env.CLOWDY_RENDERER_PORT ?? 5273);
const rendererUrl = `http://127.0.0.1:${ port }`;
// `ELECTRON_RUN_AS_NODE` (set by VS Code's extension host, for one) would start Electron as plain Node.
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...inherited } = process.env;
const env = {
    ...inherited,
    CLOWDY_RENDERER_URL: rendererUrl,
    CLOWDY_RENDERER_PORT: String(port),
    // A dev run keeps its own data folder (`Clowdy Dev`), and starts the daemon with this Bun from this checkout.
    CLOWDY_PROFILE: 'dev',
    // The daemon starts once and keeps running, so this only matters for a daemon this run starts. `fake` plays a scripted demo.
    CLOWDY_ENGINE: process.env.CLOWDY_ENGINE || 'claude',
    CLOWDY_BUN: process.execPath,
    CLOWDY_DAEMON_ENTRY: path.join(repoRoot, 'apps/daemon/src/main.ts'),
    // The app replaces the daemon when these change and it has no runs in progress.
    CLOWDY_DAEMON_WATCH: [path.join(repoRoot, 'apps/daemon/src'), path.join(repoRoot, 'packages/protocol/src')].join(path.delimiter),
};
// Vite's own script, run with Node: a `bunx` wrapper would be the process a stop kills on Windows, leaving Vite behind.
const viteBin = path.join(path.dirname(Bun.resolveSync('vite/package.json', desktopRoot)), 'bin/vite.js');
// Electron quits gracefully on SIGTERM; this is how long a restart waits before forcing it.
const QUIT_TIMEOUT_MS = 3_000;
const RENDERER_START_TIMEOUT_MS = 60_000;

let app: Subprocess | null = null;
let renderer: Subprocess | null = null;
let restarts = Promise.resolve();

process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));
// However this process ends, its children end with it.
process.on('exit', () => {
    renderer?.kill();
    app?.kill();
});

if (await listening(port)) {
    console.error(`Port ${ port } is taken, maybe by another \`./clowdy dev\`. Stop it, or set CLOWDY_RENDERER_PORT to a free port.`);
    process.exit(1);
}

// The daemon outlives the app and keeps the engine it started with, so the engine asked for reaches only a daemon this run starts.
if (process.env.CLOWDY_ENGINE && daemonRunning()) {
    console.warn(`A daemon is already running and keeps its own engine, so CLOWDY_ENGINE=${ process.env.CLOWDY_ENGINE } does not apply to it. To switch: CLOWDY_PROFILE=dev bun run --cwd apps/daemon stop`);
}

// The packages the renderer imports, built first (the icon pack is generated); turbo's cache makes a repeat run cheap.
await $`bunx turbo run dev:prepare --filter=${ '@clowdy/desktop^...' }`.cwd(repoRoot);

renderer = Bun.spawn(['node', viteBin, '--config', path.join(desktopRoot, 'vite.config.ts')], { cwd: desktopRoot, env, stdout: 'inherit', stderr: 'inherit' });
void renderer.exited.then(code => {
    console.error(`The renderer dev server stopped with code ${ code }.`);
    process.exit(1);
});
await rendererReady();
await startApp();

let pending: ReturnType<typeof setTimeout> | undefined;

// One save can fire several events; restart once they settle.
for (const folder of ['main', 'preload', 'shared']) {
    watch(path.join(desktopRoot, 'src', folder), { recursive: true }, (_event, file) => {
        if (!file || file.endsWith('.test.ts')) return;

        clearTimeout(pending);
        pending = setTimeout(() => {
            restarts = restarts.then(async () => {
                console.info(`${ folder }/${ file } changed; restarting Clowdy`);
                await quitApp();
                await startApp();
            }).catch((error: unknown) => console.error('Restart failed:', error));
        }, 200);
    });
}

async function startApp(): Promise<void> {
    try {
        await buildMain(path.join(desktopRoot, 'dist'));
    }
    catch (error) {
        console.error(error);
        console.error('Main or preload did not build; save a fix to try again.');

        return;
    }

    const started = Bun.spawn([electronBinary, '.', ...process.argv.slice(2)], { cwd: desktopRoot, env, stdio: ['inherit', 'inherit', 'inherit'] });

    app = started;
    void started.exited.then(code => {
        // A restart has already let go of it.
        if (app !== started) return;

        app = null;

        // Quitting the app ends the session; a crash waits for a fix.
        if (code === 0) process.exit(0);

        console.error(`Clowdy exited with code ${ code }; save a fix under src/main, src/preload, or src/shared to start it again.`);
    });
}

async function quitApp(): Promise<void> {
    const running = app;

    app = null;

    if (!running) return;

    running.kill('SIGTERM');

    const forced = setTimeout(() => running.kill('SIGKILL'), QUIT_TIMEOUT_MS);

    await running.exited;
    clearTimeout(forced);
}

/** True when `daemon.json` of this run's data folder names a live process. */
function daemonRunning(): boolean {
    try {
        const file = path.join(daemonDataDir({ platform: process.platform, home: homedir(), env }), 'daemon.json');

        process.kill((JSON.parse(readFileSync(file, 'utf8')) as { pid: number }).pid, 0);

        return true;
    }
    catch {
        return false;
    }
}

/** True when something accepts connections on the port. A plain TCP probe, so an HTTP proxy in the environment plays no part. */
function listening(target: number): Promise<boolean> {
    return new Promise(resolve => {
        const socket = connect(target, '127.0.0.1');

        socket.once('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.once('error', () => resolve(false));
    });
}

/** Waits until the dev server listens, so the window never opens on a refused connection. */
async function rendererReady(): Promise<void> {
    const deadline = Date.now() + RENDERER_START_TIMEOUT_MS;

    while (Date.now() < deadline) {
        if (await listening(port)) return;

        await Bun.sleep(150);
    }

    console.error(`The renderer dev server did not listen at ${ rendererUrl } within ${ RENDERER_START_TIMEOUT_MS / 1000 }s.`);
    process.exit(1);
}
