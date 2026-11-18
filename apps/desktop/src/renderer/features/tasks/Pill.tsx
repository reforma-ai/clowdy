import { cn } from '@clowdy/lib';

import styles from './Pill.module.css';

import type { ReactNode } from 'react';
import type { StatusTone } from '../../shared';

export type PillTone = StatusTone;

export interface PillProps {
    tone?: PillTone;
    children: ReactNode;
    className?: string;
}

/** A small rounded label tinted by tone: a task status, a verdict. */
export function Pill({ tone = 'neutral', children, className }: PillProps) {
    return <span className={ cn(styles.pill, className) } data-tone={ tone }>{ children }</span>;
}

export function PillLabel({ children }: { children: ReactNode }) {
    return <span className={ styles.label }>{ children }</span>;
}
