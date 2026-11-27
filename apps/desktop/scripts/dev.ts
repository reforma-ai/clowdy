/**
 * `bun run dev`: the app, rebuilt as you edit.
 *
 * - The renderer is built by `vite build --watch` into `dist/renderer` and served by the app from `app://clowdy`, as in
 *   a packaged app: the same origin and CSP, and no open port. After each rebuild lands, the app reloads its window
 *   (a marker file in the folder tells it); there is no hot module replacement, so the window's state is lost.
 * - Main and preload are bundled with Bun. A change under `src/main`, `src/preload`, `src/shared`, or `native`
 *   rebuilds them and restarts the app; so does the next save after the app crashed.
 * - Quitting the app ends the session.
 * - The app finds or starts the daemon from this checkout (`apps/daemon`) and leaves it running. It replaces a daemon
 *   whose sources changed, once it has no runs in progress (`src/main/daemonKeeper.ts`).
 *
 * Arguments go to Electron.
 */

import { readFileSync, watch } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { daemonDataDir } from '@clowdy/protocol';
import { $, type Subprocess } from 'bun';

import { DEV_BUILD_MARKER } from '../src/shared/dev';
import { buildMain } from './main-bundle';
import { buildNativeScroll } from './native-scroll';

// Outside Electron, the `electron` package exports the path to its binary (downloaded on first use).
const electronBinary = (await import('electron')).default as unknown as string;

const desktopRoot = path.resolve(import.meta.dir, '..');
const repoRoot = path.resolve(desktopRoot, '../..');
// The folder the app serves in a development run.
const rendererDir = path.join(desktopRoot, 'dist/renderer');
// `ELECTRON_RUN_AS_NODE` (set by VS Code's extension host, for one) would start Electron as plain Node.
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...inherited } = process.env;
const env = {
    ...inherited,
    CLOWDY_RENDERER_DIR: rendererDir,
    // A dev run keeps its own data folder (`Clowdy Dev`), and starts the daemon with this Bun from this checkout.
    CLOWDY_PROFILE: 'dev',
    // The daemon starts once and keeps running, so this only matters for a daemon this run starts. `fake` plays a scripted demo.
    CLOWDY_ENGINE: process.env.CLOWDY_ENGINE || 'claude',
    CLOWDY_BUN: process.execPath,
    CLOWDY_DAEMON_ENTRY: path.join(repoRoot, 'apps/daemon/src/main.ts'),
    // The app replaces the daemon when these change and it has no runs in progress. The daemon imports `@clowdy/lib/checklist` from `packages/lib` (only by subpath:
    // its lint refuses the root, which pulls in React), and the watch is by folder, so the package is watched whole.
    CLOWDY_DAEMON_WATCH: ['apps/daemon/src', 'packages/protocol/src', 'packages/lib/src']
        .map(folder => path.join(repoRoot, folder))
        .join(path.delimiter),
};
// Vite's own script, run with Node: a `bunx` wrapper would be the process a stop kills on Windows, leaving Vite behind.
const viteBin = path.join(path.dirname(Bun.resolveSync('vite/package.json', desktopRoot)), 'bin/vite.js');
// Electron quits gracefully on SIGTERM; this is how long a restart waits before forcing it.
const QUIT_TIMEOUT_MS = 3_000;
// How long the renderer's folder stays unwritten before a build counts as landed.
const QUIET_MS = 300;

let app: Subprocess | null = null;
let renderer: Subprocess | null = null;
let restarts = Promise.resolve();

process.on('SIGINT', () => stop(130));
process.on('SIGTERM', () => stop(143));
// However this process ends, its children end with it.
process.on('exit', () => {
    renderer?.kill();
    app?.kill();
});

// The daemon outlives the app and keeps the engine it started with, so the engine asked for reaches only a daemon this run starts.
if (process.env.CLOWDY_ENGINE && daemonRunning()) {
    console.warn(
        `A daemon is already running and keeps its own engine, so CLOWDY_ENGINE=${process.env.CLOWDY_ENGINE} does not apply to it. To switch: CLOWDY_PROFILE=dev bun run --cwd apps/daemon stop`
    );
}

// The packages the renderer imports, built first (the icon pack is generated); turbo's cache makes a repeat run cheap.
await $`bunx turbo run dev:prepare --filter=${'@clowdy/desktop^...'}`.cwd(repoRoot);

// Start from an empty folder, then never empty it again: files the open page still loads stay in place while a rebuild runs.
await rm(rendererDir, { recursive: true, force: true });
await mkdir(rendererDir, { recursive: true });

let lastWrite = 0;

watch(rendererDir, { recursive: true }, () => {
    lastWrite = Date.now();
});

// Development mode (readable class names, React's own warnings) and unminified, so a rebuild takes a moment.
const build = Bun.spawn(
    [
        'node',
        viteBin,
        'build',
        '--watch',
        '--config',
        path.join(desktopRoot, 'vite.config.ts'),
        '--outDir',
        rendererDir,
        '--emptyOutDir=false',
        '--minify=false',
    ],
    { cwd: desktopRoot, env: { ...env, NODE_ENV: 'development' }, stdout: 'pipe', stderr: 'inherit' }
);
let builds = 0;
let firstBuilt!: () => void;
const firstBuild = new Promise<void>(resolve => {
    firstBuilt = resolve;
});

renderer = build;
void build.exited.then(code => {
    console.error(`The renderer build stopped with code ${code}.`);
    stop(1);
});
void echoBuilds(build.stdout, async () => {
    await landed();
    builds += 1;

    if (builds === 1) {
        firstBuilt();

        return;
    }

    // A rename is one event in the folder itself, which every OS reports to a plain watch.
    await Bun.write(path.join(rendererDir, `${DEV_BUILD_MARKER}.tmp`), String(builds));
    await rename(path.join(rendererDir, `${DEV_BUILD_MARKER}.tmp`), path.join(rendererDir, DEV_BUILD_MARKER));
    console.info('The renderer was rebuilt; reloading the window');
});
await firstBuild;
await startApp();

let pending: ReturnType<typeof setTimeout> | undefined;

// One save can fire several events; restart once they settle. The addon is built before each start.
for (const folder of ['src/main', 'src/preload', 'src/shared', 'native']) {
    watch(path.join(desktopRoot, folder), { recursive: true }, (_event, file) => {
        if (!file || file.endsWith('.test.ts')) return;

        clearTimeout(pending);
        pending = setTimeout(() => {
            restarts = restarts
                .then(async () => {
                    console.info(`${folder}/${file} changed; restarting Clowdy`);
                    await quitApp();
                    await startApp();
                })
                .catch((error: unknown) => console.error('Restart failed:', error));
        }, 200);
    });
}

async function startApp(): Promise<void> {
    try {
        if (process.platform === 'darwin')
            await buildNativeScroll([`darwin-${process.arch}` as 'darwin-arm64' | 'darwin-x64']);
        await buildMain(path.join(desktopRoot, 'dist'));
    } catch (error) {
        console.error(error);
        console.error('Main, preload, or the native addon did not build; save a fix to try again.');

        return;
    }

    const started = Bun.spawn([electronBinary, '.', ...process.argv.slice(2)], {
        cwd: desktopRoot,
        env,
        stdio: ['inherit', 'inherit', 'inherit'],
    });

    app = started;
    void started.exited.then(code => {
        // A restart has already let go of it.
        if (app !== started) return;

        app = null;

        // Quitting the app ends the session; a crash waits for a fix.
        if (code === 0) process.exit(0);

        console.error(
            `Clowdy exited with code ${code}; save a fix under src/main, src/preload, src/shared, or native to start it again.`
        );
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
    } catch {
        return false;
    }
}

/** Passes the renderer build's output through and runs `built` after each build, one at a time. */
async function echoBuilds(output: ReadableStream<Uint8Array>, built: () => Promise<void>): Promise<void> {
    const decoder = new TextDecoder();
    let queue = Promise.resolve();

    for await (const chunk of output) {
        const text = decoder.decode(chunk, { stream: true });

        process.stdout.write(text);

        if (text.includes('built in')) queue = queue.then(built).catch((error: unknown) => console.error(error));
    }
}

/** Vite reports a build before every file may have landed on disk; this waits for the folder to go quiet. */
async function landed(): Promise<void> {
    while (Date.now() - lastWrite < QUIET_MS) await Bun.sleep(QUIET_MS / 2);
}

function stop(code: number): never {
    renderer?.kill();
    app?.kill();
    process.exit(code);
}
