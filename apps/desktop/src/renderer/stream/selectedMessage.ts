import { clamp } from '@clowdy/lib';

/** What a message of the list carries on its root (`UserBubble`, `AssistantMessage`): a selection is quoted only when it lies inside one of them. */
const MESSAGE = '[data-message]';

/** The words that are selected inside one message, and where the selection is on screen (viewport pixels). */
export interface SelectedText {
    /** The selection as it is drawn (`Selection.toString()`), trimmed. */
    text: string;
    /** The middle of the selection, across. */
    x: number;
    /** The top of its first line. */
    above: number;
    /** The bottom of its last line. */
    below: number;
}

export function sameSelection(a: SelectedText | null, b: SelectedText | null): boolean {
    return a === b || (a !== null && b !== null && a.text === b.text && a.x === b.x && a.above === b.above && a.below === b.below);
}

const messageAround = (node: Node): HTMLElement | null => (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(MESSAGE) ?? null;

/**
 * The message of `scope` a range lies inside. A range may start or end just outside it with nothing but line breaks between its words and that
 * edge, as a triple click does (it ends where the next paragraph starts, which can be in the next message): that still counts, the
 * words are the message's. A range that holds words of two messages, or of anything else, belongs to none.
 */
function messageHolding(range: Range, scope: Element): HTMLElement | null {
    for (const message of [messageAround(range.startContainer), messageAround(range.endContainer)]) {
        if (!message || !scope.contains(message)) continue;

        const startsIn = message.contains(range.startContainer);
        const endsIn = message.contains(range.endContainer);

        if (startsIn && endsIn) return message;

        // What lies outside the message: from its end to the end of the range, or from the start of the range to its start.
        const outside = range.cloneRange();

        if (startsIn) outside.setStart(message, message.childNodes.length);
        else outside.setEnd(message, 0);

        if (outside.toString().trim() === '') return message;
    }

    return null;
}

/** The selection of the page when it is words inside one message of `scope`, else null: nothing selected, a collapsed caret, words of two messages, or words of anything but a message (the message box, an input). */
export function readSelection(scope: Element | null): SelectedText | null {
    const selection = window.getSelection();

    if (!scope || !selection || selection.isCollapsed || selection.rangeCount === 0) return null;

    const range = selection.getRangeAt(0);

    // The cheap test first: a selection somewhere else (the whole page, a long document) is turned into text only when it is a message's.
    if (!messageHolding(range, scope)) return null;

    const text = selection.toString().trim();

    if (text === '') return null;

    // A rect with no width is the caret-like mark a line break leaves; a selection that is not drawn (a hidden message) has none at all.
    const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
    const first = rects.at(0);
    const last = rects.at(-1);

    if (!first || !last) return null;

    const box = range.getBoundingClientRect();

    return { text, x: box.left + (box.width / 2), above: first.top, below: last.bottom };
}

/** A box on screen, in viewport pixels. */
export interface Bounds {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

/** Room between the selection and the box, and between the box and the edge of the room it has, in px. */
const GAP = 6;
const MARGIN = 8;

/**
 * Where the box of `size` goes (viewport pixels, its top left): over the first line of the selection with its middle on the selection's, or under the
 * last line when there is no room above, and never past the edge of `within`: the part of the window the list shows in, so that the box does not go
 * over the title band, whose drag region takes the presses that land on it, or over the message box.
 */
export function placeToolbar(at: Pick<SelectedText, 'x' | 'above' | 'below'>, size: { width: number; height: number }, within: Bounds): { left: number; top: number } {
    const fitsAbove = at.above - GAP - size.height >= within.top + MARGIN;
    const top = fitsAbove ? at.above - GAP - size.height : at.below + GAP;

    return {
        left: clamp(within.left + MARGIN, at.x - (size.width / 2), within.right - MARGIN - size.width),
        top: clamp(within.top + MARGIN, top, within.bottom - MARGIN - size.height),
    };
}

/** The part of the window `element` shows in. */
export function visibleBounds(element: Element): Bounds {
    const rect = element.getBoundingClientRect();

    return { left: Math.max(0, rect.left), top: Math.max(0, rect.top), right: Math.min(window.innerWidth, rect.right), bottom: Math.min(window.innerHeight, rect.bottom) };
}
