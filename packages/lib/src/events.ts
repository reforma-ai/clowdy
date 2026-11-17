type AnyEventCtor = new (type: string, init?: any) => Event;

type InitOfCtor<C> = C extends new (type: string, init?: infer I) => any ? I : never;
type Registry = typeof registry;
type EventKey = keyof Registry;

type EventOf<K extends EventKey> = InstanceType<Registry[K]>;
type InitOf<K extends EventKey> = InitOfCtor<Registry[K]>;

const registry = {
    // Mouse
    click: globalThis.MouseEvent,
    auxclick: globalThis.MouseEvent,
    dblclick: globalThis.MouseEvent,
    mousedown: globalThis.MouseEvent,
    mouseup: globalThis.MouseEvent,
    mouseover: globalThis.MouseEvent,
    mousemove: globalThis.MouseEvent,
    mouseout: globalThis.MouseEvent,
    mouseenter: globalThis.MouseEvent,
    mouseleave: globalThis.MouseEvent,
    contextmenu: globalThis.MouseEvent,

    // Keyboard
    keydown: globalThis.KeyboardEvent,
    keyup: globalThis.KeyboardEvent,
    keypress: globalThis.KeyboardEvent,

    // Focus
    focus: globalThis.FocusEvent,
    blur: globalThis.FocusEvent,
    focusin: globalThis.FocusEvent,
    focusout: globalThis.FocusEvent,

    // Input
    input: globalThis.InputEvent,
    change: globalThis.Event,
    submit: globalThis.Event,
    reset: globalThis.Event,

    // Touch
    touchstart: (typeof globalThis.TouchEvent === 'function' ? globalThis.TouchEvent : globalThis.Event) as AnyEventCtor,
    touchmove: (typeof globalThis.TouchEvent === 'function' ? globalThis.TouchEvent : globalThis.Event) as AnyEventCtor,
    touchend: (typeof globalThis.TouchEvent === 'function' ? globalThis.TouchEvent : globalThis.Event) as AnyEventCtor,
    touchcancel: (typeof globalThis.TouchEvent === 'function' ? globalThis.TouchEvent : globalThis.Event) as AnyEventCtor,

    // UI
    scroll: globalThis.UIEvent,
    resize: globalThis.UIEvent,
    select: globalThis.UIEvent,

    // Wheel
    wheel: globalThis.WheelEvent,

    // Drag
    drag: globalThis.DragEvent,
    dragstart: globalThis.DragEvent,
    dragend: globalThis.DragEvent,
    dragenter: globalThis.DragEvent,
    dragover: globalThis.DragEvent,
    dragleave: globalThis.DragEvent,
    drop: globalThis.DragEvent,

    // Clipboard
    copy: globalThis.ClipboardEvent,
    cut: globalThis.ClipboardEvent,
    paste: globalThis.ClipboardEvent,

    // Custom
    custom: globalThis.CustomEvent,
} as const;

export function dispatchEvent<K extends EventKey>(
    el: Element,
    name: K,
    options?: InitOf<K>
): [boolean, EventOf<K>] {
    const Ctor = registry[name] ?? Event;
    const event = new Ctor(String(name), options as any) as EventOf<K>;
    const notCancelled = el.dispatchEvent(event);

    return [notCancelled, event];
}


/**
 * Normalize wheel event delta based on deltaMode
 *
 * @param e
 * @param winWidth
 * @param winHeight
 * @returns
 */
export function normalizeWheelDelta(e: { deltaX: number; deltaY: number; deltaMode?: number; shiftKey?: boolean }, winWidth: number = window.innerWidth, winHeight: number = window.innerHeight) {
    const factorY = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? winHeight : 1;
    const factorX = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? winWidth : 1;

    let dx = e.deltaX * factorX;
    let dy = e.deltaY * factorY;

    // Shift-scroll: if deltaX is 0 and shift is pressed, convert vertical scroll to horizontal
    if (e.shiftKey && dx === 0) {
        dx = dy;
        dy = 0;
    }

    return { dx, dy };
}

