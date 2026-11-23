/** The row of a file in the sidebar's list, and a card of the reading area, each named by its path. */
const ROW = '[data-path]';
const CARD = '[data-card]';
/** The field above the cards: where the focus goes when the last card has gone. */
const FILTER_FIELD = 'input[aria-label="Filter files"]';
/** How long the focus is looked after once a discard went through: the row and the card go with the next read of the place, a round trip or two later. */
const WAIT_MS = 5000;

/**
 * Where a discarded file was, read when the discard is asked for: its row or its card (`host`), the paths of the rows or cards around it (the next ones first, then the ones
 * before it, the nearest first), where they are looked for again (`scope`), and what takes the focus when none of them is left.
 */
export interface DiscardSpot {
    host: HTMLElement;
    scope: HTMLElement;
    attribute: 'data-path' | 'data-card';
    neighbours: string[];
    /** What of a row or a card takes the focus: the row itself, the card's fold button. */
    focusOf: (item: HTMLElement) => HTMLElement | null;
    fallback: HTMLElement | null;
}

function neighbourPaths(host: HTMLElement, items: HTMLElement[], attribute: string): string[] {
    const at = items.indexOf(host);
    const paths = (list: HTMLElement[]) => list.map(item => item.getAttribute(attribute) ?? '');

    return [...paths(items.slice(at + 1)), ...paths(items.slice(0, Math.max(at, 0)).reverse())];
}

/** The nearest element above `from` that holds a `selector`. */
function closestHolding(from: HTMLElement, selector: string): HTMLElement | null {
    for (let element = from.parentElement; element; element = element.parentElement) {
        if (element.querySelector(selector)) return element;
    }

    return null;
}

/** The spot of the file whose `Discard changes…` was pressed (`trigger`, the button): in a row of the sidebar's list, or in a card's header. */
export function discardSpot(trigger: Element): DiscardSpot | undefined {
    const row = trigger.closest<HTMLElement>(ROW);
    const files = row?.closest<HTMLElement>('section');

    if (row && files) {
        return {
            host: row,
            scope: files,
            attribute: 'data-path',
            neighbours: neighbourPaths(row, [...files.querySelectorAll<HTMLElement>(ROW)], 'data-path'),
            focusOf: item => item,
            // The list goes with its last row: the section it was in, which has the empty state then.
            fallback: files,
        };
    }

    const card = trigger.closest<HTMLElement>(CARD);
    const reading = card && closestHolding(card, FILTER_FIELD);

    if (card && reading) {
        return {
            host: card,
            scope: reading,
            attribute: 'data-card',
            neighbours: neighbourPaths(card, [...reading.querySelectorAll<HTMLElement>(CARD)], 'data-card'),
            focusOf: item => item.querySelector<HTMLElement>('button[aria-expanded]'),
            fallback: reading.querySelector<HTMLElement>(FILTER_FIELD),
        };
    }

    return undefined;
}

/** The row or card after the one that went, or the nearest one before it, of those still drawn. */
function neighbourOf(spot: DiscardSpot): HTMLElement | undefined {
    const items = [...spot.scope.querySelectorAll<HTMLElement>(`[${spot.attribute}]`)];

    return spot.neighbours
        .map(path => items.find(item => item.getAttribute(spot.attribute) === path))
        .find(item => item !== undefined);
}

/**
 * Keeps the focus where the discarded file was. Its row or card goes with the next read of the place, and the button that had the focus with it, which leaves the focus on the page:
 * then the next row or card takes it, or the one before it when it was the last, or `fallback` when the list is empty. A row or card that stays (a file the branch had changed too)
 * loses only its button, and takes the focus itself. It waits for the confirmation to close, and a focus the person put somewhere else is left where it is.
 */
export function keepFocusWhenGone(spot: DiscardSpot, wait = WAIT_MS): void {
    const until = Date.now() + wait;

    const look = () => {
        if (Date.now() > until) return;

        if (!document.querySelector('[data-modal-window]')) {
            const active = document.activeElement;
            const lost = !active || active === document.body || !active.isConnected;

            if (lost) {
                const item = spot.host.isConnected ? spot.host : neighbourOf(spot);
                const target = item && spot.focusOf(item);

                (target ?? spot.fallback)?.focus();
            }

            // Done once the row or the card has gone: the focus is on its neighbour, or where the person put it.
            if (!spot.host.isConnected) return;
        }

        requestAnimationFrame(look);
    };

    requestAnimationFrame(look);
}
