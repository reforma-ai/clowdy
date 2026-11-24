import { ArrowDown, ArrowUp } from '@clowdy/icons/14';

import styles from './CommitCountBadge.module.css';

export function CommitCountBadge({ count, direction }: { count: number; direction: 'up' | 'down' }) {
    const Arrow = direction === 'up' ? ArrowUp : ArrowDown;

    return (
        <span className={styles.badge} aria-hidden="true" data-commit-count={direction}>
            <Arrow size={10} />
            {count}
        </span>
    );
}
