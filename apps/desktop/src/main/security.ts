import { WINDOW_MATERIAL_ARGUMENT } from '../shared/bridge';

import type { BrowserWindowConstructorOptions, CustomScheme, Session, WebContents } from 'electron';

/** The page's top band, in CSS pixels. Windows centers its caption buttons in an overlay of this height. */
const TITLE_BAR_HEIGHT = 48;

/** First Windows build whose Desktop Window Manager draws Mica for `backgroundMaterial`. */
const WINDOWS_MICA_BUILD = 22621;

export const APP_SCHEME = 'app';
export const APP_HOST = 'clowdy';
export const APP_ORIGIN = `${ APP_SCHEME }://${ APP_HOST }`;

/** `app:` is a standard, secure origin with `fetch`; it gets no CSP bypass, CORS, or service workers. */
export const appScheme: CustomScheme = {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
};

/** The third field of `os.release()`. On Windows that field is the build number. */
export function windowsBuild(version: string): number {
    const build = Number(version.split('.')[2]);

    return Number.isFinite(build) ? build : 0;
}

/** The Windows caption buttons' symbol color over a light or dark page. */
export function captionSymbolColor(dark: boolean): string {
    return dark ? '#ffffff' : '#000000';
}

/**
 * Platform chrome for the app window. macOS gets vibrancy; Windows 11 22H2 and newer
 * gets Mica. Older Windows keeps the custom title bar on a solid window. Linux is unchanged.
 * A clear `backgroundColor` lets the material show through transparent page pixels.
 */
export function windowChrome(platform: NodeJS.Platform, build: number, dark = false): BrowserWindowConstructorOptions {
    if (platform === 'darwin') {
        return {
            titleBarStyle: 'hidden',
            titleBarOverlay: true,
            // Centered in the page's 48px top band. The overlay's `titlebar-area-*` variables describe it to the page.
            trafficLightPosition: { x: 17, y: 17 },
            vibrancy: 'under-window',
            visualEffectState: 'active',
            backgroundColor: '#00000000',
        };
    }

    if (platform === 'win32') {
        return {
            titleBarStyle: 'hidden',
            titleBarOverlay: {
                color: '#00000000',
                symbolColor: captionSymbolColor(dark),
                height: TITLE_BAR_HEIGHT,
            },
            ...build >= WINDOWS_MICA_BUILD && {
                backgroundMaterial: 'mica',
                backgroundColor: '#00000000',
            },
        };
    }

    return {};
}

/**
 * Options for the app window; the renderer is untrusted. The preload runs in the
 * main frame only: with `nodeIntegrationInSubFrames` off, subframes get no preload.
 * `build` is the Windows build number and `dark` the appearance; other platforms ignore them.
 */
export function windowOptions(preload: string, platform: NodeJS.Platform = process.platform, build = 0, dark = false): BrowserWindowConstructorOptions {
    const chrome = windowChrome(platform, build, dark);
    const material = chrome.vibrancy != null || chrome.backgroundMaterial != null;

    return {
        width: 1440,
        height: 900,
        minWidth: 960,
        minHeight: 600,
        show: false,
        ...chrome,
        webPreferences: {
            preload,
            additionalArguments: material ? [WINDOW_MATERIAL_ARGUMENT] : [],
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            nodeIntegrationInSubFrames: false,
            nodeIntegrationInWorker: false,
            webviewTag: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            experimentalFeatures: false,
            navigateOnDragDrop: false,
            safeDialogs: true,
        },
    };
}

const EXTERNAL_OPEN_INTERVAL_MS = 1000;

/**
 * `scheme://host` of a URL. `URL.origin` is the string "null" for a custom scheme such as `app:`,
 * so origins are compared this way.
 */
export function originOf(url: string): string | undefined {
    const parsed = URL.parse(url);

    return parsed ? `${ parsed.protocol }//${ parsed.host }` : undefined;
}

/** True for a URL on the trusted origin: the app's own scheme, or the dev server in a development run. */
export function isTrustedUrl(url: string | undefined, trustedOrigin: string): boolean {
    return url !== undefined && originOf(url) === trustedOrigin;
}

/** The window stays on the trusted origin; `https:` links leave for the system browser. */
function navigationDecision(url: string, trustedOrigin: string): 'allow' | 'external' | 'deny' {
    if (isTrustedUrl(url, trustedOrigin)) return 'allow';

    return URL.parse(url)?.protocol === 'https:' ? 'external' : 'deny';
}

/**
 * Locks navigation, `window.open`, and `<webview>` for one web contents. External
 * opens are throttled, so a framed page cannot flood the system browser with tabs.
 */
export function lockNavigation(
    contents: Pick<WebContents, 'on' | 'setWindowOpenHandler'>,
    trustedOrigin: string,
    openExternal: (url: string) => void
): void {
    let lastExternalOpen = Number.NEGATIVE_INFINITY;
    const openOutside = (url: string) => {
        // A monotonic clock: a wall clock set back would block every link until it caught up.
        if (performance.now() - lastExternalOpen < EXTERNAL_OPEN_INTERVAL_MS) return;

        lastExternalOpen = performance.now();
        openExternal(url);
    };

    contents.on('will-navigate', event => {
        const decision = navigationDecision(event.url, trustedOrigin);

        if (decision === 'allow') return;

        event.preventDefault();

        if (decision === 'external') openOutside(event.url);
    });

    contents.setWindowOpenHandler(({ url }) => {
        if (navigationDecision(url, trustedOrigin) === 'external') openOutside(url);

        return { action: 'deny' };
    });

    contents.on('will-attach-webview', event => event.preventDefault());
}

/**
 * Refuses every permission request and check, devices included, except clipboard
 * writes from the app's own top-level page, which every copy control needs.
 */
export function restrictPermissions(
    session: Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler' | 'setDevicePermissionHandler'>,
    trustedOrigin: string
): void {
    const allowed = (permission: string, isMainFrame: boolean, url: string | undefined) =>
        permission === 'clipboard-sanitized-write' && isMainFrame && isTrustedUrl(url, trustedOrigin);

    session.setPermissionRequestHandler((_contents, permission, callback, details) => {
        callback(allowed(permission, details.isMainFrame, details.requestingUrl));
    });
    session.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) =>
        allowed(permission, details.isMainFrame, details.requestingUrl ?? requestingOrigin));
    session.setDevicePermissionHandler(() => false);
}

/**
 * A packaged app starts without command-line switches: a debugging port, a proxy,
 * relaxed certificates, or another profile would each hand out the session.
 * Chromium on Windows also reads `/switch`.
 */
export function hasLaunchSwitches(argv: readonly string[], platform: NodeJS.Platform = process.platform): boolean {
    return argv.some(arg => arg.startsWith('-') || (platform === 'win32' && arg.startsWith('/')));
}
