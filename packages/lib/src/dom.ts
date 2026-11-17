/**
 * Checks if target is a DOM element
 */
export function isElement(target: any): target is Element {
    if (!target || typeof target !== 'object') {
        return false;
    }

    return (target as Element).nodeType != null;
}

/**
 * Get relative cursor position relative to element
 */
export function getRelativeCursorPos(element: Element, event: Pick<MouseEvent, 'clientX' | 'clientY'>, scale = 1): { x: number; y: number } {
    const rect = element.getBoundingClientRect();

    const x = (event.clientX - rect.left) / scale;
    const y = (event.clientY - rect.top) / scale;

    return { x, y };
}

/**
 * Check if element is scrollable
 */
export function isScrollable(el: Element): boolean {
    if (!(el instanceof HTMLElement)) {
        return false;
    }

    const style = getComputedStyle(el);

    const canOverflowY = /(auto|scroll|overlay)/.test(style.overflowY);
    const canOverflowX = /(auto|scroll|overlay)/.test(style.overflowX);

    const hasRoomY = el.scrollHeight > el.clientHeight;
    const hasRoomX = el.scrollWidth > el.clientWidth;

    return (canOverflowY && hasRoomY) || (canOverflowX && hasRoomX);
}

/**
 * Finds the nearest scrollable element
 *
 * @param node - Element to start searching from
 * @returns Scrollable element
 */
export function scrollParent(node: Element | null): Element {
    if (!node) {
        return document.scrollingElement ?? document.documentElement;
    }

    const doc = node.ownerDocument ?? document;
    const rootEl = doc.documentElement;

    let el: Element | null = node;

    while (el && el !== rootEl) {
        if (isScrollable(el)) {
            return el;
        }

        const parentElement = el.parentElement as HTMLElement;

        if (parentElement) {
            el = parentElement;
        }
        // Maybe shadow root?
        else {
            const root = el.getRootNode?.();

            el = (root instanceof ShadowRoot ? root.host : null);
        }
    }

    return doc.scrollingElement ?? rootEl;
}

/**
 * Get rects and bounds of any element (HTML, SVG, Text)
 * @param element - Any DOM element (HTMLElement, SVGElement, Text)
 * @param range - Range (optional, useful for reusing range)
 * @returns Rects and bounds of the element
 */
export function getElementRects(element: Element | Text, range = document.createRange()): { rects: DOMRect[]; bounds: DOMRect } {
    // For text nodes, use range to get accurate text rects
    if (element.nodeType === Node.TEXT_NODE) {
        range.selectNodeContents(element);

        return {
            rects: Array.from(range.getClientRects()).map(rect => rect.toJSON()),
            bounds: range.getBoundingClientRect().toJSON(),
        };
    }

    // For regular elements, use getBoundingClientRect and getClientRects
    const elementNode = element as Element;

    return {
        rects: Array.from(elementNode.getClientRects()).map(rect => rect.toJSON()),
        bounds: elementNode.getBoundingClientRect().toJSON(),
    };
}

/**
 * Whether a prop name is a typical DOM / host-element attribute (vs custom or library-only props).
 * Use when splitting spread props between a wrapper element and an inner component.
 *
 * Matches `aria-*`, `data-*`, React event handlers (`on` + uppercase), `ref`, and common global HTML attributes.
 * Does not include `className`, `children`, or `style` — decide those at the call site.
 */
export function isHtmlProp(key: string): boolean {
    if (key.startsWith('aria-') || key.startsWith('data-')) {
        return true;
    }

    if (/^on[A-Z]/.test(key)) {
        return true;
    }

    switch (key) {
        case 'ref':
        case 'id':
        case 'role':
        case 'tabIndex':
        case 'title':
        case 'hidden':
        case 'lang':
        case 'dir':
        case 'accessKey':
        case 'draggable':
        case 'inert':
        case 'nonce':
        case 'slot':
        case 'spellCheck':
        case 'autoFocus':
        case 'translate':
        case 'popover':
        case 'exportparts':
        case 'part':
        case 'suppressHydrationWarning':
        case 'suppressContentEditableWarning':
        case 'contentEditable':
        case 'inputMode':
        case 'is':
            return true;

        default:
            return false;
    }
}
