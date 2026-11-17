/**
 * Loads a URL in a hidden Electron window and saves a PNG, so a page can be checked without a person at the screen.
 *
 *   bun apps/desktop/scripts/screenshot.ts --url <url> --out <png>
 *     [--width 1440] [--height 900] [--wait-for <css selector>] [--eval <js>]... [--delay <ms>]
 *     [--theme light|dark|system] [--overlay] [--logs]
 *
 * It waits for the selector (default `#root > *`), runs each `--eval` in the page in order (an expression that
 * returns a promise is awaited; a returned value is printed), waits `--delay`, and captures. Page console errors
 * and warnings are printed; an error, a failed load, or the 30 s timeout ends with a non-zero exit code.
 * `--overlay` opens the window with the hidden title bar and its window controls overlay, as the app's window has on
 * this OS, so `env(titlebar-area-*)` has real values (the controls themselves are not part of a capture).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const TIMEOUT_MS = 30_000;
/** The Electron process gets this long to report its own timeout before it is killed. */
const KILL_GRACE_MS = 5_000;

const { values } = parseArgs({
    options: {
        url: { type: 'string' },
        out: { type: 'string' },
        width: { type: 'string', default: '1440' },
        height: { type: 'string', default: '900' },
        'wait-for': { type: 'string', default: '#root > *' },
        eval: { type: 'string', multiple: true, default: [] },
        delay: { type: 'string', default: '0' },
        theme: { type: 'string' },
        overlay: { type: 'boolean', default: false },
        logs: { type: 'boolean', default: false },
    },
});

if (!values.url || !values.out) {
    console.error('Usage: bun apps/desktop/scripts/screenshot.ts --url <url> --out <png> [--width N] [--height N] [--wait-for <selector>] [--eval <js>]... [--delay <ms>] [--theme light|dark|system] [--overlay] [--logs]');
    process.exit(2);
}

const userDataDir = mkdtempSync(path.join(tmpdir(), 'clowdy-shoot-'));
const options = {
    url: values.url,
    out: path.resolve(values.out),
    width: Number(values.width),
    height: Number(values.height),
    waitFor: values['wait-for'],
    evals: values.eval,
    delayMs: Number(values.delay),
    theme: values.theme,
    overlay: values.overlay,
    logs: values.logs,
    timeoutMs: TIMEOUT_MS,
    userDataDir,
};
// Outside Electron, the `electron` package exports the path to its binary.
const electronBinary = (await import('electron')).default as unknown as string;
// `ELECTRON_RUN_AS_NODE` (set by VS Code's extension host, for one) would start Electron as plain Node.
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...inherited } = process.env;
const child = Bun.spawn([electronBinary, path.join(import.meta.dir, 'shoot-main.cjs')], {
    // The security warning is about the dev server's CSP, which a shot of a dev page cannot act on.
    env: { ...inherited, CLOWDY_SHOOT: JSON.stringify(options), ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    stdio: ['ignore', 'inherit', 'inherit'],
});
const killer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS + KILL_GRACE_MS);
const code = await child.exited;

clearTimeout(killer);
rmSync(userDataDir, { recursive: true, force: true });
process.exit(code);
