import { cn } from '@clowdy/lib';
import { Children, type HTMLAttributes, type ReactNode } from 'react';

import styles from './StreamCard.module.css';

import type { ThreadOutcome } from '@clowdy/protocol';

export interface StreamCardProps {
    /** What a test or a style finds the card by: `agent-card`, `thread-message`, `question`. */
    slot: string;
    /** The mark that opens the header: the title and the mark are one line, and the body under the rule starts at the card's edge. */
    icon: ReactNode;
    /** The header's words (a link, a shimmer). */
    title: ReactNode;
    /** Additional information aligned to the right of the header. */
    trailing?: ReactNode;
    /** How the work ended, for a test or a style. */
    outcome?: ThreadOutcome;
    /** Opens what the card is about: the title becomes the button, and its box stretches over the card, so a press anywhere on the plate opens it. */
    onPress?: () => void;
    /** What describes the title's button: a line in the body. */
    'aria-describedby'?: string;
    busy?: boolean;
    /** The stream item the card is, so the turn rail can scroll to it. */
    turn?: string;
    /** What is under the header, past its rule. A card with nothing to say has no body and no rule. */
    children?: ReactNode;
}

/**
 * The one frame of every card of other work in a stream (a message another thread wrote, a sub-agent or a thread, running or over) and of a
 * question that is over: the plate, a header that holds the icon, and under a rule the rows of the body.
 */
export function StreamCard({
    slot,
    icon,
    title,
    trailing,
    outcome,
    onPress,
    'aria-describedby': describedBy,
    busy,
    turn,
    children,
}: StreamCardProps) {
    return (
        <div
            className={styles.card}
            data-slot={slot}
            data-outcome={outcome}
            data-pressable={onPress ? '' : undefined}
            data-turn={turn}
            aria-busy={busy || undefined}
        >
            <div className={styles.head}>
                <span className={styles.icon} aria-hidden>
                    {icon}
                </span>
                <span className={styles.title}>
                    {onPress ? (
                        <button type="button" className={styles.press} aria-describedby={describedBy} onClick={onPress}>
                            {title}
                        </button>
                    ) : (
                        title
                    )}
                </span>
                {trailing}
            </div>
            {Children.toArray(children).length > 0 && <div className={styles.body}>{children}</div>}
        </div>
    );
}

export interface StreamPlateProps extends HTMLAttributes<HTMLDivElement> {
    /** `lg` for a request that brings its own heading and buttons, `sm` for a form that brings its own bands. */
    size: 'sm' | 'lg';
    /** It is over: the same frame, without the plate. */
    settled?: boolean;
}

/** The frame of what the run waits on in the stream (a question, a request for permission): it stands out of the line of tool calls. */
export function StreamPlate({ size, settled, className, ...props }: StreamPlateProps) {
    return (
        <div
            {...props}
            className={cn(styles.plate, className)}
            data-size={size}
            data-settled={settled ? '' : undefined}
        />
    );
}
