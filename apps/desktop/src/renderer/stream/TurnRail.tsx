import { Scrollable } from '@clowdy/components/Scrollable';
import { Show } from '@clowdy/components/Show';
import { Text } from '@clowdy/components/Text';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import styles from './TurnRail.module.css';
import { scrollStreamToTurn, TURN_RAIL_MIN, type TurnMark } from './turnMarks';

import type { PointerEvent, RefObject } from 'react';

/** How wide the lengthening reaches, in pixels: a few ticks either side of the pointer. */
const WAVE = 16;

/** How far from its end a stream still counts as scrolled to it, in pixels: a fractional scroll position never lands on the exact end. */
const AT_END = 2;

/** Room between the card and the rail, and between the card and the window edge. */
const CARD_GAP = 8;

export interface TurnRailProps {
    marks: readonly TurnMark[];
    /** The stream the ticks jump in. */
    scroller: RefObject<HTMLDivElement | null>;
}

function applyWave(rail: HTMLElement, y: number | null) {
    for (const tick of rail.querySelectorAll<HTMLElement>('[data-tick]')) {
        const mark = tick.querySelector<HTMLElement>('[data-mark]');

        if (!mark) continue;

        if (y == null) {
            mark.style.removeProperty('--lift');
            continue;
        }

        const box = tick.getBoundingClientRect();
        const distance = Math.abs(y - (box.top + box.height / 2));
        const lift = Math.exp(-(distance * distance) / (2 * WAVE * WAVE));

        if (lift < 0.08) mark.style.removeProperty('--lift');
        else mark.style.setProperty('--lift', lift.toFixed(3));
    }
}

/** The tick the pointer is on. The target wins; the Y is for a scroll that moved the ticks under a still pointer. */
function tickIdFrom(event: PointerEvent<HTMLElement>): string | null {
    const target = event.target;

    if (target instanceof Element) {
        const tick = target.closest('[data-tick]');

        if (tick && event.currentTarget.contains(tick)) return tick.getAttribute('data-tick');
    }

    return tickIdAt(event.currentTarget, event.clientY);
}

function tickIdAt(root: HTMLElement, y: number): string | null {
    for (const tick of root.querySelectorAll<HTMLElement>('[data-tick]')) {
        const box = tick.getBoundingClientRect();

        if (y >= box.top && y <= box.bottom) return tick.dataset.tick ?? null;
    }

    return null;
}

/**
 * One card for the whole rail. `slide` moves it from where it already is;
 * the first placement, and a follow while the lane scrolls, snaps.
 */
function placeCard(card: HTMLElement, frame: HTMLElement, tick: HTMLElement, slide: boolean) {
    const frameBox = frame.getBoundingClientRect();
    const tickBox = tick.getBoundingClientRect();
    const height = card.offsetHeight;
    let top = tickBox.top + tickBox.height / 2 - height / 2;
    const max = window.innerHeight - CARD_GAP - height;

    top = Math.min(Math.max(top, CARD_GAP), Math.max(CARD_GAP, max));

    const instant = !slide || card.dataset.placed !== 'true';

    if (instant) card.style.transition = 'none';

    card.style.top = `${top}px`;
    card.style.right = `${Math.max(CARD_GAP, window.innerWidth - frameBox.left + CARD_GAP)}px`;

    if (instant) {
        card.getBoundingClientRect();
        card.style.transition = '';
    }

    card.dataset.placed = 'true';
}

/**
 * The turns of a stream, as a short column of ticks on its right.
 * Hidden below {@link TURN_RAIL_MIN} messages. Past 420px the column scrolls, faded at the edges, with no thumb.
 */
export function TurnRail({ marks, scroller }: TurnRailProps) {
    const shown = marks.length >= TURN_RAIL_MIN;
    const railRef = useRef<HTMLDivElement>(null);
    const laneRef = useRef<HTMLDivElement>(null);
    const cardRef = useRef<HTMLDivElement>(null);
    const marksRef = useRef(marks);
    const hoverRef = useRef<string | null>(null);
    const pointerY = useRef<number | null>(null);
    const slideRef = useRef(false);
    const [activeId, setActiveId] = useState<string | null>(null);
    const [hoverId, setHoverId] = useState<string | null>(null);
    const markKey = marks.map(mark => mark.id).join('\0');

    marksRef.current = marks;

    const hovered = marks.find(mark => mark.id === hoverId) ?? null;
    const cardMark = hovered && (hovered.title !== '' || hovered.reply !== '') ? hovered : null;

    useLayoutEffect(() => {
        const card = cardRef.current;
        const frame = railRef.current;

        if (!card || !frame || !cardMark) return;

        const tick = frame.querySelector<HTMLElement>(`[data-tick="${CSS.escape(cardMark.id)}"]`);

        if (!tick) return;

        const slide = slideRef.current;

        slideRef.current = false;
        placeCard(card, frame, tick, slide);
    }, [cardMark]);

    useEffect(() => {
        const scroll = scroller.current;

        if (!shown || !scroll) return;

        const read = () => {
            const list = marksRef.current;
            const edge = scroll.getBoundingClientRect().top + 12;
            let next = list[0]?.id ?? null;

            for (const mark of list) {
                const message = scroll.querySelector<HTMLElement>(`[data-turn="${CSS.escape(mark.id)}"]`);

                if (!message) continue;

                if (message.getBoundingClientRect().top <= edge) next = mark.id;
                else break;
            }

            // A stream scrolled to its end shows the last turn, even when that turn is too short to have reached the top.
            const isScrollable = scroll.scrollHeight > scroll.clientHeight;

            if (
                isScrollable &&
                scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= AT_END &&
                list.length > 0
            )
                next = list[list.length - 1].id;

            setActiveId(current => (current === next ? current : next));
        };

        read();
        scroll.addEventListener('scroll', read, { passive: true });
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);

        observer?.observe(scroll);

        return () => {
            scroll.removeEventListener('scroll', read);
            observer?.disconnect();
        };
    }, [markKey, scroller, shown]);

    useEffect(() => {
        const rail = railRef.current;
        const lane = laneRef.current;

        if (!rail || !lane || activeId == null || rail.matches(':hover')) return;

        const tick = rail.querySelector<HTMLElement>(`[data-tick="${CSS.escape(activeId)}"]`);

        if (!tick) return;

        const laneBox = lane.getBoundingClientRect();
        const tickBox = tick.getBoundingClientRect();

        if (tickBox.top < laneBox.top) lane.scrollTop -= laneBox.top - tickBox.top;
        else if (tickBox.bottom > laneBox.bottom) lane.scrollTop += tickBox.bottom - laneBox.bottom;
    }, [activeId]);

    if (!shown) return null;

    const move = (event: PointerEvent<HTMLDivElement>) => {
        applyWave(event.currentTarget, event.clientY);
        pointerY.current = event.clientY;

        const id = tickIdFrom(event);

        if (id === hoverRef.current) return;

        slideRef.current = hoverRef.current != null && id != null;
        hoverRef.current = id;
        setHoverId(id);
    };

    const rest = (event: PointerEvent<HTMLDivElement>) => {
        applyWave(event.currentTarget, null);
        pointerY.current = null;
        hoverRef.current = null;
        slideRef.current = false;
        setHoverId(null);
    };

    const follow = () => {
        const frame = railRef.current;
        const y = pointerY.current;

        if (!frame || y == null) return;

        const id = tickIdAt(frame, y);
        const card = cardRef.current;

        if (id !== hoverRef.current) {
            slideRef.current = false;
            hoverRef.current = id;
            setHoverId(id);

            return;
        }

        if (!card || !id) return;

        const tick = frame.querySelector<HTMLElement>(`[data-tick="${CSS.escape(id)}"]`);

        if (tick) placeCard(card, frame, tick, false);
    };

    return (
        <div ref={railRef} className={styles.frame} onPointerMove={move} onPointerLeave={rest}>
            <Scrollable
                role="navigation"
                aria-label="Messages"
                scrollbar={false}
                edgeFade
                vertical
                className={styles.rail}
                containerClass={styles.lane}
                contentClass={styles.ticks}
                containerRef={laneRef}
                onScroll={follow}
            >
                {marks.map(mark => (
                    <button
                        key={mark.id}
                        type="button"
                        className={styles.tick}
                        data-tick={mark.id}
                        data-current={mark.id === activeId || undefined}
                        aria-current={mark.id === activeId || undefined}
                        aria-label={mark.title || 'Message'}
                        tabIndex={-1}
                        onClick={() => {
                            const scroll = scroller.current;

                            if (scroll) scrollStreamToTurn(scroll, mark.id);
                        }}
                    >
                        <span className={styles.mark} data-mark="" />
                    </button>
                ))}
            </Scrollable>
            {cardMark &&
                createPortal(
                    <div ref={cardRef} className={styles.card} data-turn-card="" aria-hidden="true">
                        <Show when={cardMark.title !== ''}>
                            <Text as="p" variant="sm" weight="medium" className={styles.title}>
                                {cardMark.title}
                            </Text>
                        </Show>
                        <Show when={cardMark.reply !== ''}>
                            <Text as="p" variant="sm" color="secondary" className={styles.reply}>
                                {cardMark.reply}
                            </Text>
                        </Show>
                    </div>,
                    document.body
                )}
        </div>
    );
}
