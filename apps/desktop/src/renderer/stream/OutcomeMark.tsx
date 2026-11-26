import { Completed, Error as ErrorMark, TaskCanceled } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';

import styles from './OutcomeMark.module.css';

import type { ThreadOutcome } from '@clowdy/protocol';

const ICONS = { finished: Completed, failed: ErrorMark, interrupted: TaskCanceled } as const;

/** How a thread or a sub-agent ended, as a mark with its colour: a check in the success colour, a cross in the danger colour, the stopped mark in the muted one. One place for the cards and for the queue's rows. */
export function OutcomeMark({ outcome, className }: { outcome: ThreadOutcome; className?: string }) {
    const Icon = ICONS[outcome];

    return <Icon className={cn(styles.mark, className)} data-outcome={outcome} aria-hidden />;
}
