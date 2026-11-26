/** Room between the card and what it stands beside, and between the card and the window edge. */
export const CARD_GAP = 8;

/**
 * Puts one card level with `target`, on the `side` of `frame` (the box the card stands beside), kept inside the window.
 * `slide` moves it from where it already is; the first placement, and a follow while a list scrolls, snaps.
 */
export function placeCard(
    card: HTMLElement,
    frame: HTMLElement,
    target: HTMLElement,
    side: 'left' | 'right',
    slide: boolean
) {
    const frameBox = frame.getBoundingClientRect();
    const targetBox = target.getBoundingClientRect();
    const height = card.offsetHeight;
    let top = targetBox.top + targetBox.height / 2 - height / 2;
    const max = window.innerHeight - CARD_GAP - height;

    top = Math.min(Math.max(top, CARD_GAP), Math.max(CARD_GAP, max));

    const instant = !slide || card.dataset.placed !== 'true';

    if (instant) card.style.transition = 'none';

    card.style.top = `${top}px`;

    if (side === 'left') card.style.right = `${Math.max(CARD_GAP, window.innerWidth - frameBox.left + CARD_GAP)}px`;
    else {
        const edge = window.innerWidth - CARD_GAP - card.offsetWidth;

        card.style.left = `${Math.max(CARD_GAP, Math.min(frameBox.right + CARD_GAP, edge))}px`;
    }

    if (instant) {
        card.getBoundingClientRect();
        card.style.transition = '';
    }

    card.dataset.placed = 'true';
}
