import { useNow } from '../../../shared/useNow';
import styles from './UsageBlock.module.css';
import { UsageReading } from './UsageRows';

import type { AgentUsage } from '@clowdy/protocol';

/**
 * What is left of a plan, a bar per window, or why there is nothing. It has no title: the bars say what they are. The button that reads
 * the usage again is in the card's first row, beside the sign-in button.
 */
export function UsageBlock({ usage }: { usage: AgentUsage }) {
    // Only a card that shows usage keeps a clock.
    const now = useNow();

    return (
        <section className={styles.block} aria-label="Usage">
            <UsageReading usage={usage} now={now} />
        </section>
    );
}
