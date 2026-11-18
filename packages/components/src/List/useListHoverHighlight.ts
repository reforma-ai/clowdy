import { useEffect, type RefObject } from 'react';

import styles from './ListBox.module.css';

const DEFAULT_ITEM = `.${ styles.item }`;

/** Keep the plate across the few pixels between rows. Empty space is farther than this. */
const ROW_GAP = 16;
const SCROLL_IDLE_MS = 150;

function scrollPort(node: HTMLElement): HTMLElement {
    let current = node.parentElement;

    while (current && current !== document.documentElement) {
        const overflow = getComputedStyle(current).overflowY;

        if (overflow === 'auto' || overflow === 'scroll') {
            return current;
        }

        current = current.parentElement;
    }

    return node;
}

type ListTarget = RefObject<HTMLElement | null> | HTMLElement | null;

function resolveList(target: ListTarget): HTMLElement | null {
    if (target instanceof HTMLElement) {
        return target;
    }

    return target?.current ?? null;
}

/**
 * Slides one highlight plate across list/menu rows (hover + keyboard), instead of painting each row.
 */
export function useListHoverHighlight(
    list: ListTarget,
    enabled: boolean,
    itemSelector: string = DEFAULT_ITEM
) {
    const listEl = list instanceof HTMLElement ? list : null;

    useEffect(() => {
        const root = resolveList(list);

        if (!root || !enabled) {
            return;
        }

        let followKeyboard = false;
        let scrolling = false;
        let scrollTimer = 0;
        let current: HTMLElement | null = null;
        let pointerX = 0;
        let pointerY = 0;
        let hasPointer = false;

        const rowFrom = (target: EventTarget | null) => {
            if (!(target instanceof Element)) {
                return null;
            }

            const row = target.closest<HTMLElement>(itemSelector);

            if (!row || !root.contains(row)) {
                return null;
            }

            return row;
        };

        const blocked = (row: HTMLElement) => (
            row.hasAttribute('data-disabled')
            || row.hasAttribute('data-selected')
            || row.hasAttribute('data-highlighted')
            || row.hasAttribute('data-nested-selected')
        );

        const keyboardRow = () => (
            root.querySelector<HTMLElement>(`${ itemSelector }[data-focus-visible]`)
        );

        const besideCurrent = (x: number, y: number) => {
            if (!current) {
                return false;
            }

            const box = current.getBoundingClientRect();

            return x >= box.left && x <= box.right
                && y >= box.top - ROW_GAP && y <= box.bottom + ROW_GAP;
        };

        const setGeometry = (row: HTMLElement) => {
            const listRect = root.getBoundingClientRect();
            const rowRect = row.getBoundingClientRect();

            root.style.setProperty('--clowdy-listbox-highlight-top', `${ rowRect.top - listRect.top + root.scrollTop }px`);
            root.style.setProperty('--clowdy-listbox-highlight-left', `${ rowRect.left - listRect.left + root.scrollLeft }px`);
            root.style.setProperty('--clowdy-listbox-highlight-width', `${ rowRect.width }px`);
            root.style.setProperty('--clowdy-listbox-highlight-height', `${ rowRect.height }px`);
        };

        const hide = () => {
            current = null;
            root.style.setProperty('--clowdy-listbox-highlight-opacity', '0');
            root.removeAttribute('data-highlight-ready');
            root.removeAttribute('data-highlight-danger');
        };

        const show = (row: HTMLElement | null) => {
            if (!row || blocked(row)) {
                hide();

                return;
            }

            const appeared = current == null;

            if (appeared) {
                root.removeAttribute('data-highlight-ready');
            }

            current = row;
            setGeometry(row);
            root.toggleAttribute('data-highlight-danger', row.classList.contains(styles.itemDanger));
            root.style.setProperty('--clowdy-listbox-highlight-opacity', '1');

            if (appeared) {
                requestAnimationFrame(() => {
                    if (current) {
                        root.setAttribute('data-highlight-ready', '');
                    }
                });
            }
        };

        const followPointer = (target: EventTarget | null, x: number, y: number) => {
            followKeyboard = false;
            const row = rowFrom(target);

            if (row) {
                if (row !== current) {
                    show(row);
                }

                return;
            }

            if (!besideCurrent(x, y)) {
                hide();
            }
        };

        const onPointerMove = (event: PointerEvent) => {
            // A pointer that really moved while the list scrolls under it takes the plate back from the keyboard once the scroll ends.
            // One that did not (the browser repeats its position as rows pass under it) leaves the plate with the key.
            if (event.clientX !== pointerX || event.clientY !== pointerY) {
                followKeyboard = false;
            }

            pointerX = event.clientX;
            pointerY = event.clientY;
            hasPointer = true;

            if (scrolling) {
                return;
            }

            followPointer(event.target, event.clientX, event.clientY);
        };

        const onPointerEnter = (event: PointerEvent) => {
            pointerX = event.clientX;
            pointerY = event.clientY;
            hasPointer = true;

            if (scrolling) {
                return;
            }

            followPointer(
                document.elementFromPoint(event.clientX, event.clientY),
                event.clientX,
                event.clientY
            );
        };

        const onPointerLeave = (event: PointerEvent) => {
            if (event.relatedTarget instanceof Node && root.contains(event.relatedTarget)) {
                return;
            }

            hasPointer = false;

            if (current?.hasAttribute('data-open')) {
                return;
            }

            if (followKeyboard) {
                show(keyboardRow());

                return;
            }

            hide();
        };

        const onKeyDown = () => {
            followKeyboard = true;
            requestAnimationFrame(() => {
                if (followKeyboard) {
                    show(keyboardRow());
                }
            });
        };

        // Focus the list's keys did not move: a command that owns a key (`J` and `K`) stops its keydown before it reaches the list and moves the focus itself.
        // Pointer focus has no `data-focus-visible`, so it leaves the plate where the pointer put it.
        const onFocusIn = () => {
            requestAnimationFrame(() => {
                const row = keyboardRow();

                if (!row) {
                    return;
                }

                followKeyboard = true;
                show(row);
            });
        };

        const finishScroll = () => {
            scrolling = false;

            // A key that moved the focus far enough scrolled the list too: the scroll hid the plate, so give it back to the row the key chose.
            if (followKeyboard) {
                show(keyboardRow());

                return;
            }

            if (!hasPointer) {
                return;
            }

            show(rowFrom(document.elementFromPoint(pointerX, pointerY)));
        };

        const onScroll = () => {
            window.clearTimeout(scrollTimer);

            if (!scrolling) {
                scrolling = true;
                hide();
            }

            scrollTimer = window.setTimeout(finishScroll, SCROLL_IDLE_MS);
        };

        // Selection lands after pointerup. Re-run show so a blocked row drops the plate.
        const rowState = new MutationObserver(() => {
            if (current) {
                show(current);
            }
        });

        rowState.observe(root, {
            subtree: true,
            attributes: true,
            attributeFilter: ['data-selected', 'data-disabled', 'data-highlighted', 'data-nested-selected'],
        });

        const port = scrollPort(root);

        root.addEventListener('pointerenter', onPointerEnter);
        root.addEventListener('pointermove', onPointerMove);
        root.addEventListener('pointerleave', onPointerLeave);
        root.addEventListener('keydown', onKeyDown);
        root.addEventListener('focusin', onFocusIn);
        root.addEventListener('scroll', onScroll, { passive: true });

        if (port !== root) {
            port.addEventListener('scroll', onScroll, { passive: true });
        }

        show(root.querySelector<HTMLElement>(`${ itemSelector }:hover`));

        return () => {
            rowState.disconnect();
            window.clearTimeout(scrollTimer);
            root.removeEventListener('pointerenter', onPointerEnter);
            root.removeEventListener('pointermove', onPointerMove);
            root.removeEventListener('pointerleave', onPointerLeave);
            root.removeEventListener('keydown', onKeyDown);
            root.removeEventListener('focusin', onFocusIn);
            root.removeEventListener('scroll', onScroll);
            port.removeEventListener('scroll', onScroll);
            hide();
            root.style.removeProperty('--clowdy-listbox-highlight-top');
            root.style.removeProperty('--clowdy-listbox-highlight-left');
            root.style.removeProperty('--clowdy-listbox-highlight-width');
            root.style.removeProperty('--clowdy-listbox-highlight-height');
            root.style.removeProperty('--clowdy-listbox-highlight-opacity');
        };
    }, [enabled, itemSelector, list, listEl]);
}
