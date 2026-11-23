import { BrowserWindow, nativeTheme } from 'electron';

/**
 * The page of the boot window, which holds the first launch of a shell version while the newest bundle downloads. Static
 * and the shell's own, with a policy that runs no script: main loads it as a `data:` URL and moves its bar.
 */
export function bootPage(): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Clowdy</title>
<style>
    :root { color-scheme: light dark; }
    html, body { height: 100%; margin: 0; }
    body {
        display: grid;
        place-content: center;
        justify-items: center;
        gap: 14px;
        font: 13px/1.4 system-ui, sans-serif;
        background: Canvas;
        color: CanvasText;
        cursor: default;
        user-select: none;
        -webkit-app-region: drag;
    }
    h1 { margin: 0; font-size: 15px; font-weight: 600; }
    #bar { width: 220px; height: 4px; overflow: hidden; border-radius: 2px; background: color-mix(in srgb, CanvasText 15%, transparent); }
    #fill { width: 0; height: 100%; background: AccentColor; }
    #percent { margin: 0; opacity: 0.6; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<h1>Updating Clowdy…</h1>
<div id="bar" role="progressbar" aria-label="Updating Clowdy" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div id="fill"></div></div>
<p id="percent">0%</p>
</body>
</html>`;
}

/** The script that moves the page's bar to `fraction`, 0 to 1, in whole percents. */
export function progressScript(fraction: number): string {
    const percent = Number.isFinite(fraction) ? Math.round(Math.min(Math.max(fraction, 0), 1) * 100) : 0;

    return `(() => {
    document.getElementById('bar').setAttribute('aria-valuenow', '${percent}');
    document.getElementById('fill').style.width = '${percent}%';
    document.getElementById('percent').textContent = '${percent}%';
})()`;
}

export interface BootWindow {
    /** Moves the bar; 0 to 1. */
    progress: (fraction: number) => void;
    close: () => void;
}

/** Shows the boot window. It has no frame, so it closes only with `close` (or when the app quits). */
export function showBootWindow(): BootWindow {
    const window = new BrowserWindow({
        width: 320,
        height: 160,
        frame: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        show: false,
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#121212' : '#ffffff',
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false },
    });
    let loaded = false;
    let shown = -1;
    let latest = 0;

    // A change under one percent moves nothing, and a download reports by the chunk.
    const apply = () => {
        const percent = Math.round(latest * 100);

        if (!loaded || percent === shown || window.isDestroyed()) return;

        shown = percent;
        void window.webContents.executeJavaScript(progressScript(latest)).catch(() => undefined);
    };

    window.once('ready-to-show', () => window.show());
    window.webContents.once('did-finish-load', () => {
        loaded = true;
        apply();
    });
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(bootPage())}`);

    return {
        progress(fraction) {
            latest = fraction;
            apply();
        },
        close() {
            if (!window.isDestroyed()) window.close();
        },
    };
}
