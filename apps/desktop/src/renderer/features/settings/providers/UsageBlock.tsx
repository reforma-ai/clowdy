import styles from './UsageBlock.module.css';
import { UsageHeader, UsageReading } from './UsageRows';
import { useNow } from './useNow';

import type { AgentUsage } from '@clowdy/protocol';

export interface UsageBlockProps {
    usage: AgentUsage;
    /** A read is on its way. */
    isRefreshing: boolean;
    onRefresh: () => void;
}

/** What is left of a plan, a bar per window, with a button that reads it again. Says why there is nothing when there is nothing. */
export function UsageBlock({ usage, isRefreshing, onRefresh }: UsageBlockProps) {
    // Only a card that shows usage keeps a clock.
    const now = useNow();

    return (
        <section className={ styles.block } aria-label="Usage">
            <UsageHeader isRefreshing={ isRefreshing } onRefresh={ onRefresh } />
            <UsageReading usage={ usage } now={ now } />
        </section>
    );
}
