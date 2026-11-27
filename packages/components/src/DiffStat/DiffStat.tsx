import { cn } from '@clowdy/lib';

import styles from './DiffStat.module.css';

export interface DiffStatProps {
    added: number;
    removed: number;
    className?: string;
}

/** The size of a change as `+N −M`, in code type, added in the success colour and removed in the danger colour. */
export function DiffStat({ added, removed, className }: DiffStatProps) {
    return (
        <span className={cn(styles.diffStat, className)}>
            <span className={styles.added}>{`+${added}`}</span>
            <span className={styles.removed}>{`−${removed}`}</span>
        </span>
    );
}

DiffStat.displayName = 'DiffStat';
