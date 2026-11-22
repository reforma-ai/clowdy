/**
 * Electron entry of `screenshot.ts`: loads one URL in a hidden window, runs the steps, writes a PNG.
 * Options arrive as JSON in `CLOWDY_SHOOT`. Exit codes: 0 done, 1 the page logged errors, 2 failed or timed out.
 * No preload and no single-instance lock, so it runs next to a running Clowdy.
 */
const { app, BrowserWindow, nativeTheme } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');

const options = JSON.parse(process.env.CLOWDY_SHOOT);
const POLL_MS = 100;
const pageErrors = [];

app.setPath('userData', options.userDataDir);
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
if (options.theme) nativeTheme.themeSource = options.theme;
if (process.platform === 'darwin') app.dock?.hide();

const timeout = setTimeout(() => finish(2, `Timed out after ${ options.timeoutMs / 1000 }s`), options.timeoutMs);

function finish(code, message) {
    if (message) console.error(message);

    clearTimeout(timeout);
    app.exit(code);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The app window's hidden title bar and overlay, so the page sees `env(titlebar-area-*)` the way it does there. */
function chromeOptions() {
    if (!options.overlay) return {};

    return process.platform === 'win32'
        ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#000000', height: 44 } }
        : { titleBarStyle: 'hidden', titleBarOverlay: true, trafficLightPosition: { x: 17, y: 15 } };
}

async function waitFor(contents, selector) {
    const expression = `document.querySelector(${ JSON.stringify(selector) }) !== null`;

    while (!(await contents.executeJavaScript(expression))) await sleep(POLL_MS);
}

async function run() {
    const window = new BrowserWindow({
        width: options.width,
        height: options.height,
        useContentSize: true,
        show: false,
        ...chromeOptions(),
        webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true },
    });
    const contents = window.webContents;

    contents.on('console-message', ({ level, message }) => {
        if (level === 'warning') console.error(`[page warning] ${ message }`);
        else if (level === 'error') {
            pageErrors.push(message);
            console.error(`[page error] ${ message }`);
        }
        else if (options.logs) console.error(`[page ${ level }] ${ message }`);
    });
    contents.on('did-fail-load', (_event, code, description, url) => finish(2, `The page did not load (${ code } ${ description }): ${ url }`));
    contents.on('render-process-gone', (_event, details) => finish(2, `The page process is gone: ${ details.reason }`));

    await window.loadURL(options.url);
    await waitFor(contents, options.waitFor);

    for (const step of options.evals) {
        const result = await contents.executeJavaScript(step);

        if (result !== undefined) console.log(`[eval] ${ JSON.stringify(result) }`);
    }

    await sleep(options.delayMs);

    const image = await contents.capturePage(undefined, { stayHidden: true, stayAwake: true });

    if (image.isEmpty()) return finish(2, 'The capture is empty');

    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, image.toPNG());

    const size = image.getSize();

    console.log(`Saved ${ options.out } (${ size.width }x${ size.height })`);
    finish(pageErrors.length > 0 ? 1 : 0, pageErrors.length > 0 ? `${ pageErrors.length } page error(s)` : undefined);
}

app.whenReady().then(run).catch(error => finish(2, `Failed: ${ error?.stack ?? error }`));
