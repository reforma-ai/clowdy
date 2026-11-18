import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { Refresh } from '@clowdy/icons/14';

import { formatRemaining } from '../../../shared';
import styles from './UsageBlock.module.css';

import type { AgentUsage, AgentUsageWindow } from '@clowdy/protocol';

export interface UsageBlockProps {
    usage: AgentUsage;
    now: number;
    /** A read is on its way. */
    isRefreshing: boolean;
    onRefresh: () => void;
}

const percentOf = (window: AgentUsageWindow) => Math.min(100, Math.max(0, Math.round(window.usedPercent)));

/** One window: its label, a bar, how much is used, and when it resets. */
function UsageRow({ window, now }: { window: AgentUsageWindow; now: number }) {
    const percent = percentOf(window);

    return (
        <li className={ styles.row }>
            <Text variant="sm" color="secondary" truncate className={ styles.label } title={ window.label }>{ window.label }</Text>
            <div className={ styles.track } role="progressbar" aria-label={ `${ window.label } used` } aria-valuemin={ 0 } aria-valuemax={ 100 } aria-valuenow={ percent }>
                <div className={ styles.fill } data-level={ percent >= 90 ? 'high' : percent >= 75 ? 'warn' : undefined } style={ { width: `${ percent }%` } } />
            </div>
            <Text variant="sm" className={ styles.percent }>{ `${ percent }%` }</Text>
            <Text variant="sm" color="secondary" className={ styles.reset } title="Time until the window resets">
                { window.resetsAt === undefined ? '' : formatRemaining(window.resetsAt - now) }
            </Text>
        </li>
    );
}

/** What is left of a plan, a bar per window, with a button that reads it again. Says why there is nothing when there is nothing. */
export function UsageBlock({ usage, now, isRefreshing, onRefresh }: UsageBlockProps) {
    const { state, windows, detail } = usage;

    return (
        <section className={ styles.block } aria-label="Usage">
            <div className={ styles.header }>
                <Text variant="sm" bold>Usage</Text>
                <Button variant="inline" color="secondary" size="xs" iconOnly aria-label="Read the usage again" tooltip="Read the usage again" isPending={ isRefreshing } onPress={ onRefresh }>
                    <Refresh />
                </Button>
            </div>

            { windows.length > 0 && (
                <ul className={ styles.rows } data-stale={ state === 'error' || undefined }>
                    { windows.map(window => <UsageRow key={ window.id } window={ window } now={ now } />) }
                </ul>
            ) }

            { windows.length === 0 && state === 'ok' && <Text variant="sm" color="secondary">There are no limits to show.</Text> }
            { state !== 'ok' && detail && <Text variant="sm" color={ state === 'error' ? 'danger' : 'secondary' }>{ detail }</Text> }
            { state === 'error' && !detail && <Text variant="sm" color="danger">The usage could not be read.</Text> }
        </section>
    );
}
