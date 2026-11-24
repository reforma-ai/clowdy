const CARD = '[data-card]';
/** The field above the cards: where the focus goes when the last card has gone. */
const FILTER_FIELD = 'input[aria-label="Filter files"]';
/** How long the focus is looked after once a discard went through: the card goes with the next read of the place, a round trip or two later. */
const WAIT_MS = 5000;

interface DiscardSpot {
    host: HTMLElement;
    scope: HTMLElement;
    neighbours: string[];
    fallback: HTMLElement | null;
}

function neighbourPaths(host: HTMLElement, items: HTMLElement[]): string[] {
    const at = items.indexOf(host);
    const paths = (list: HTMLElement[]) => list.map(item => item.dataset.card ?? '');

    return [...paths(items.slice(at + 1)), ...paths(items.slice(0, Math.max(at, 0)).reverse())];
}

/** The nearest element above `from` that holds a `selector`. */
function closestHolding(from: HTMLElement, selector: string): HTMLElement | null {
    for (let element = from.parentElement; element; element = element.parentElement) {
        if (element.querySelector(selector)) return element;
    }

    return null;
}

/** Remember the card and its neighbours before opening the discard confirmation. */
export function discardSpot(trigger: Element): DiscardSpot | undefined {
    const card = trigger.closest<HTMLElement>(CARD);
    const reading = card && closestHolding(card, FILTER_FIELD);

    if (card && reading) {
        return {
            host: card,
            scope: reading,
            neighbours: neighbourPaths(card, [...reading.querySelectorAll<HTMLElement>(CARD)]),
            fallback: reading.querySelector<HTMLElement>(FILTER_FIELD),
        };
    }

    return undefined;
}

/** The card after the one that went, or the nearest one before it, of those still drawn. */
function neighbourOf(spot: DiscardSpot): HTMLElement | undefined {
    const items = [...spot.scope.querySelectorAll<HTMLElement>(CARD)];

    return spot.neighbours.map(path => items.find(item => item.dataset.card === path)).find(item => item !== undefined);
}

/** Return focus to the card, a surviving neighbour, or the filter after a discard. */
export function keepFocusWhenGone(spot: DiscardSpot, wait = WAIT_MS): void {
    const until = Date.now() + wait;

    const look = () => {
        if (Date.now() > until) return;

        if (!document.querySelector('[data-modal-window]')) {
            const active = document.activeElement;
            const lost = !active || active === document.body || !active.isConnected;

            if (lost) {
                const item = spot.host.isConnected ? spot.host : neighbourOf(spot);
                const target = item?.querySelector<HTMLElement>('button[aria-expanded]');

                (target ?? spot.fallback)?.focus();
            }

            // Done once the card has gone: the focus is on its neighbour, or where the person put it.
            if (!spot.host.isConnected) return;
        }

        requestAnimationFrame(look);
    };

    requestAnimationFrame(look);
}
