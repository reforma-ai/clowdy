import { Button } from '@clowdy/components/Button';
import { Show } from '@clowdy/components/Show';
import { ChevronDown } from '@clowdy/icons/8';
import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from 'react';

import styles from './Clamp.module.css';

export interface ClampProps {
    children: ReactNode;
    /** How many lines show until the person opens the rest. */
    lines: number;
    /** The toggle's words while the text is clamped (`Show full message`); open, it says `Show less`. */
    moreLabel: string;
    /** Where the toggle sits: under the end of a bubble, or under the start of a card. */
    align?: 'start' | 'end';
}

/** Clamps a long text to a few lines under a fade. The toggle shows only when the clamp hides something. */
export function Clamp({ children, lines, moreLabel, align = 'end' }: ClampProps) {
    const content = useRef<HTMLDivElement>(null);
    const [expanded, setExpanded] = useState(false);
    const [clipped, setClipped] = useState(false);

    useLayoutEffect(() => {
        const inner = content.current;
        const clamp = inner?.parentElement;

        if (!inner || !clamp || expanded) return;

        const measure = () => setClipped(clamp.scrollHeight > clamp.clientHeight + 1);
        const observer = new ResizeObserver(measure);

        measure();
        observer.observe(inner);

        return () => observer.disconnect();
    }, [expanded]);

    return (
        <>
            <div
                className={styles.clamp}
                data-expanded={expanded}
                data-clipped={clipped}
                style={{ '--clamp-lines': lines } as CSSProperties}
            >
                <div ref={content}>{children}</div>
            </div>
            <Show when={clipped}>
                <Button
                    variant="inline"
                    color="secondary"
                    className={styles.toggle}
                    data-align={align}
                    aria-expanded={expanded}
                    onPress={() => setExpanded(!expanded)}
                >
                    {expanded ? 'Show less' : moreLabel}
                    <ChevronDown className="chevron" aria-expanded={expanded} aria-hidden />
                </Button>
            </Show>
        </>
    );
}
