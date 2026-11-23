import { TERMINAL_SCROLLBACK } from '@clowdy/protocol';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal as XTerm } from '@xterm/xterm';

import { hotkeys } from '../../hotkeys/registry';
import { isAppShortcut, shellSequence } from './shellKeys';
import { terminalTheme } from './terminalTheme';

import type { TerminalScreen } from '@clowdy/protocol';
import type { TerminalStream } from '../../daemon/terminalStream';
import type { Transport } from '../../daemon/transport';
import type { TerminalSession, TerminalViewHandle } from './TerminalsStore';

/** Lets a drag of the panel edge settle before the shell learns its size. */
const RESIZE_DEBOUNCE_MS = 100;

/** The fewest cells a host may hold to be fitted to: below it the host is still being laid out. */
const MIN_FIT_COLS = 10;
const MIN_FIT_ROWS = 3;

/** RIS: a full reset in the stream itself, so it lands after the output that was written before it and wipes it, instead of racing with it. */
const RESET = '\x1bc';

const isDark = () => document.documentElement.classList.contains('dark');

/** Font and colors: the font from the host's computed style, so the tab's CSS module owns the look, and the colors from the plate behind it. */
function xtermOptions(host: HTMLElement): ConstructorParameters<typeof XTerm>[0] {
    const style = getComputedStyle(host);

    return {
        cursorBlink: true,
        scrollback: TERMINAL_SCROLLBACK,
        allowProposedApi: true,
        fontFamily: style.fontFamily || 'monospace',
        fontSize: Number.parseFloat(style.fontSize) || 12,
        lineHeight: 1.2,
        // Sets the scrollbar track width (default 14); the tab's CSS paints a thinner thumb inside it.
        overviewRuler: { width: 8 },
        theme: terminalTheme(style, isDark()),
    };
}

export interface TerminalViewOptions {
    transport: Pick<Transport, 'openTerminal'>;
    /** The daemon no longer has the terminal. */
    onGone: () => void;
}

/**
 * One terminal on screen. It owns a single xterm for the life of the session, so the scrollback survives a switch of tab or panel: React only moves the xterm's
 * element between hosts. It also owns the session's stream: the daemon starts it with the screen as it is, which the xterm takes in place of what it showed, so
 * a reload, a reconnect and a first look are all the same thing here.
 */
export class TerminalView implements TerminalViewHandle {
    readonly #session: TerminalSession;
    readonly #options: TerminalViewOptions;
    #xterm: XTerm | undefined;
    #fit: FitAddon | undefined;
    #host: HTMLElement | undefined;
    #stream: TerminalStream | undefined;
    #resizeTimer: ReturnType<typeof setTimeout> | undefined;
    #disposed = false;

    constructor(session: TerminalSession, options: TerminalViewOptions) {
        this.#session = session;
        this.#options = options;
    }

    /** Puts the xterm into `host`, making it (and opening the stream) on first use, and sizes it to the host. */
    mount(host: HTMLElement): void {
        if (this.#disposed) return;

        this.#host = host;

        if (this.#xterm) {
            if (this.#xterm.element && this.#xterm.element.parentElement !== host) host.append(this.#xterm.element);

            // The colors may have changed while the terminal was off screen.
            this.syncTheme();
            this.fit();
            this.#xterm.refresh(0, this.#xterm.rows - 1);
        } else {
            this.#create(host);
        }

        this.#xterm?.focus();
    }

    /** Leaves the host and takes the xterm's element along. */
    unmount(): void {
        this.#host = undefined;
        this.#xterm?.element?.remove();
    }

    focus(): void {
        this.#xterm?.focus();
    }

    /** Fits the xterm to its host and tells the shell the new size; a hidden (0×0) host is ignored. */
    fit(): void {
        const host = this.#host;

        if (this.#disposed || !host || !this.#xterm || !this.#fit || host.clientWidth === 0 || host.clientHeight === 0)
            return;

        const size = this.#fit.proposeDimensions();

        if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return;

        const { cols, rows } = size;

        // A host this small is not laid out yet (the panel is opening, the element was just moved into it): fitting to it would reflow the screen into a
        // sliver, and growing it back does not bring the line the cursor is on back.
        if (cols < MIN_FIT_COLS || rows < MIN_FIT_ROWS) return;

        if (cols === this.#xterm.cols && rows === this.#xterm.rows) return;

        this.#xterm.resize(cols, rows);
        clearTimeout(this.#resizeTimer);
        this.#resizeTimer = setTimeout(() => this.#stream?.resize(cols, rows), RESIZE_DEBOUNCE_MS);
    }

    /** Re-reads the colors of the plate, after the window changed between light and dark. */
    syncTheme(): void {
        if (this.#xterm && this.#host)
            this.#xterm.options.theme = terminalTheme(getComputedStyle(this.#host), isDark());
    }

    dispose(): void {
        this.#disposed = true;
        clearTimeout(this.#resizeTimer);
        this.#stream?.close();
        this.#xterm?.dispose();
        this.#stream = undefined;
        this.#xterm = undefined;
    }

    #create(host: HTMLElement): void {
        const xterm = new XTerm({
            ...xtermOptions(host),
            // Links a program marks itself (OSC 8).
            linkHandler: { activate: (event, uri) => this.#openLink(event, uri) },
        });
        const fit = new FitAddon();

        xterm.loadAddon(fit);
        xterm.loadAddon(new Unicode11Addon());
        xterm.unicode.activeVersion = '11';
        xterm.loadAddon(new WebLinksAddon((event, uri) => this.#openLink(event, uri)));
        xterm.attachCustomKeyEventHandler(event => this.#handleKey(xterm, event));
        xterm.open(host);
        this.#loadWebgl(xterm);
        xterm.onData(data => void this.#stream?.write(data));
        this.#xterm = xterm;
        this.#fit = fit;
        this.#syncInput();
        this.fit();

        this.#stream = this.#options.transport.openTerminal(this.#session.id, {
            onScreen: screen => this.#showScreen(screen),
            onOutput: data => this.#xterm?.write(data),
            onExit: code => this.#showExit(code),
            onStatus: status => {
                this.#session.setStatus(status);
                this.#syncInput();
            },
            onGone: () => this.#options.onGone(),
        });
    }

    /** The daemon's picture of the screen replaces everything shown, at the size the shell has; then the xterm is fitted to its host, which tells the shell if that is another size. */
    #showScreen(screen: TerminalScreen): void {
        const xterm = this.#xterm;

        if (!xterm) return;

        this.#session.update({ cols: screen.cols, rows: screen.rows, state: screen.state, exitCode: screen.exitCode });
        xterm.resize(screen.cols, screen.rows);
        xterm.write(RESET + screen.screen, () => {
            if (screen.state === 'exited') this.#writeExitLine(screen.exitCode);

            this.#syncInput();
            this.fit();
        });
    }

    #showExit(code: number): void {
        this.#session.update({ state: 'exited', exitCode: code });
        this.#writeExitLine(code);
        this.#syncInput();
    }

    #writeExitLine(code: number | undefined): void {
        this.#xterm?.write(`\r\n\x1b[2m[Process exited with code ${code ?? '?'}]\x1b[0m\r\n`);
    }

    /** Typing while the shell is gone or the stream is down would be lost, so the terminal refuses it. */
    #syncInput(): void {
        if (this.#xterm) this.#xterm.options.disableStdin = !this.#session.isRunning || this.#session.status !== 'open';
    }

    /** WebGL draws fast output much faster; on a lost context xterm falls back to its DOM renderer. */
    #loadWebgl(xterm: XTerm): void {
        try {
            const webgl = new WebglAddon();

            webgl.onContextLoss(() => webgl.dispose());
            xterm.loadAddon(webgl);
        } catch {
            // The DOM renderer stays.
        }
    }

    /** Cmd+click (Ctrl+click off Mac) opens a link, as in native terminals; the shell decides which links go to the system browser. */
    #openLink(event: MouseEvent, uri: string): void {
        if (hotkeys.platform === 'darwin' ? event.metaKey : event.ctrlKey)
            window.open(uri, '_blank', 'noopener,noreferrer');
    }

    /** `false` keeps xterm from handling the key. */
    #handleKey(xterm: XTerm, event: KeyboardEvent): boolean {
        // The app's own keys go on to the window's hotkeys.
        if (isAppShortcut(event, hotkeys.platform)) return false;

        const sequence = shellSequence(event, hotkeys.platform);

        if (sequence !== undefined) {
            event.preventDefault();
            xterm.input(sequence);

            return false;
        }

        if (event.type !== 'keydown' || hotkeys.platform === 'darwin' || event.altKey || !event.ctrlKey) return true;

        // Off Mac, Ctrl+C copies a selection (else it is ^C), Ctrl+Shift+C always copies, and Ctrl+V lets the browser paste.
        if (event.code === 'KeyC' && (event.shiftKey || xterm.hasSelection())) {
            event.preventDefault();

            if (xterm.hasSelection()) {
                void navigator.clipboard.writeText(xterm.getSelection());
                xterm.clearSelection();
            }

            return false;
        }

        return event.code !== 'KeyV';
    }
}
