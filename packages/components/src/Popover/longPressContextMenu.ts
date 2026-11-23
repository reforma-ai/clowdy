/** How long a touch is held still before it is a long press. */
const LONG_PRESS_MS = 500;
/** How far a held touch may drift, in px, before it is a drag or a scroll and not a long press. */
const LONG_PRESS_SLOP = 10;
/** How long after a long press of ours a context menu event of the browser's own is taken for the same press. */
const NATIVE_ECHO_MS = 1000;

/** A field of text keeps its long press for the browser: the selection handles and the native menu. */
const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

interface Holding {
    timer: number;
    x: number;
    y: number;
}

/**
 * Makes a touch held still open the context menu of what is under it, so every menu that opens on a right-click (`onContextMenu`, `useContextMenu`) opens on a
 * touch screen too, with no code of its own. After half a second without moving, a `contextmenu` event is sent to the element under the finger, where the handlers
 * are as they are for a right-click, with the same selection logic and the same point. When one of them handled it (`preventDefault`), the press is over: the
 * pointer is cancelled, as the browser does for its own long press (a React Aria press does not take the release for a press), and the click that comes with
 * the release is swallowed. A touch that is let go early, drifts or turns into a scroll is not a long press, and nothing changes for it; a field of text is left
 * to the browser. Where the browser sends a `contextmenu` for a long touch itself (Chromium with a touch screen), that one is used and the timer is dropped, or
 * dropped as a repeat when ours came first.
 *
 * Install once for the window; returns a function that removes it.
 */
export function installLongPressContextMenu(doc: Document = document): () => void {
    const win = doc.defaultView ?? window;
    let holding: Holding | undefined;
    let swallowClick = false;
    let firedAt = Number.NEGATIVE_INFINITY;

    const stop = () => {
        if (holding) win.clearTimeout(holding.timer);

        holding = undefined;
    };

    const press = (target: Element, event: PointerEvent) => {
        holding = undefined;

        if (!target.isConnected) return;

        const { clientX, clientY, screenX, screenY, pointerId } = event;
        const menu = new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: win,
            button: 2,
            clientX,
            clientY,
            screenX,
            screenY,
        });

        // `dispatchEvent` is false when a handler prevented the default, which is what a handler that opens a menu does.
        if (target.dispatchEvent(menu)) return;

        swallowClick = true;
        firedAt = performance.now();
        target.dispatchEvent(
            new PointerEvent('pointercancel', { bubbles: true, pointerId, pointerType: 'touch', isPrimary: true })
        );
    };

    const onPointerDown = (event: PointerEvent) => {
        // A new gesture: a click that was left over from the last one (its release landed on the menu) is not its own.
        swallowClick = false;
        stop();

        const { target } = event;

        if (
            event.pointerType !== 'touch' ||
            !event.isPrimary ||
            !(target instanceof Element) ||
            target.closest(EDITABLE)
        )
            return;

        holding = {
            x: event.clientX,
            y: event.clientY,
            timer: win.setTimeout(() => press(target, event), LONG_PRESS_MS),
        };
    };

    const onPointerMove = (event: PointerEvent) => {
        if (holding && Math.hypot(event.clientX - holding.x, event.clientY - holding.y) > LONG_PRESS_SLOP) stop();
    };

    const onContextMenu = (event: MouseEvent) => {
        // Ours are not trusted. The browser's own, while a touch is held, is its long press: it opens the menu, so the timer is not needed. After ours it is the same press again.
        if (!event.isTrusted) return;

        if (holding) {
            stop();
        } else if (performance.now() - firedAt < NATIVE_ECHO_MS) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    };

    const onClick = (event: MouseEvent) => {
        if (!swallowClick) return;

        swallowClick = false;
        event.preventDefault();
        event.stopPropagation();
    };

    doc.addEventListener('pointerdown', onPointerDown, true);
    doc.addEventListener('pointermove', onPointerMove, true);
    doc.addEventListener('pointerup', stop, true);
    doc.addEventListener('pointercancel', stop, true);
    doc.addEventListener('contextmenu', onContextMenu, true);
    doc.addEventListener('click', onClick, true);

    return () => {
        stop();
        doc.removeEventListener('pointerdown', onPointerDown, true);
        doc.removeEventListener('pointermove', onPointerMove, true);
        doc.removeEventListener('pointerup', stop, true);
        doc.removeEventListener('pointercancel', stop, true);
        doc.removeEventListener('contextmenu', onContextMenu, true);
        doc.removeEventListener('click', onClick, true);
    };
}
