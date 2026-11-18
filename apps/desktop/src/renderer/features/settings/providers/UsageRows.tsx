import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { Refresh } from '@clowdy/icons/14';

import { formatRemaining } from '../../../shared';
import { InlineCode } from './InlineCode';
import { sortWindowsByUsage, usageTone, windowPercent } from './providerView';
import styles from './UsageRows.module.css';

import type { AgentUsage, AgentUsageWindow } from '@clowdy/protocol';

/** One window: its label, a bar, how much is used, and when it resets. The bar turns warning at 80% and danger at 90% (`usageTone`). */
function UsageRow({ window, now }: { window: AgentUsageWindow; now: number }) {
    const percent = windowPercent(window);
    const tone = usageTone(percent);

    return (
        <li className={ styles.row }>
            <Text variant="sm" color="secondary" truncate className={ styles.label } title={ window.label }>{ window.label }</Text>
            <div className={ styles.track } role="progressbar" aria-label={ `${ window.label } used` } aria-valuemin={ 0 } aria-valuemax={ 100 } aria-valuenow={ percent } aria-valuetext={ `${ percent }%` }>
                <div className={ styles.fill } data-tone={ tone === 'normal' ? undefined : tone } style={ { width: `${ percent }%` } } />
            </div>
            <Text variant="sm" className={ styles.percent }>{ `${ percent }%` }</Text>
            <Text variant="sm" color="secondary" className={ styles.reset } title={ window.resetsAt === undefined ? undefined : 'Time until the window resets' }>
                { window.resetsAt === undefined ? '' : formatRemaining(window.resetsAt - now) }
            </Text>
        </li>
    );
}

export interface UsageHeaderProps {
    /** A read is on its way. */
    isRefreshing: boolean;
    onRefresh: () => void;
}

/** The title of a usage block and the button that reads the usage again; shared by a provider's card and the window header's popover. */
export function UsageHeader({ isRefreshing, onRefresh }: UsageHeaderProps) {
    return (
        <div className={ styles.header }>
            <Text variant="sm" bold>Usage</Text>
            <Button variant="inline" color="secondary" size="xs" iconOnly aria-label="Read the usage again" tooltip="Read the usage again" isPending={ isRefreshing } onPress={ onRefresh }>
                <Refresh />
            </Button>
        </div>
    );
}

/** Says why there is nothing to show, or why what is shown is old: the daemon's own words when it has some. Nothing when the usage is fine. */
function UsageNote({ usage }: { usage: AgentUsage }) {
    const { state, windows, detail } = usage;

    if (state !== 'ok' && detail) {
        return <Text variant="sm" color={ state === 'error' ? 'danger' : 'secondary' }><InlineCode text={ detail } /></Text>;
    }

    if (state === 'error') return <Text variant="sm" color="danger">The usage could not be read.</Text>;

    return windows.length === 0 ? <Text variant="sm" color="secondary">There are no limits to show.</Text> : null;
}

export interface UsageReadingProps {
    usage: AgentUsage;
    /** The time the resets are counted from; the caller's ticking clock, so every row of a screen agrees. */
    now: number;
    /** Show the most used window first, not in the order the daemon gave. */
    byUsage?: boolean;
}

/**
 * What a provider's usage says, shared by the Providers page and the window header's popover: a bar per window (the last good
 * reading, faded, when the newest read failed) and, under them, the daemon's own words when there is something to explain.
 * The columns of a row come from `--usage-columns`, which a narrower place sets on a parent.
 */
export function UsageReading({ usage, now, byUsage = false }: UsageReadingProps) {
    const windows = byUsage ? sortWindowsByUsage(usage.windows) : usage.windows;

    return (
        <>
            { windows.length > 0 && (
                <ul className={ styles.rows } data-stale={ usage.state === 'error' || undefined }>
                    { windows.map(window => <UsageRow key={ window.id } window={ window } now={ now } />) }
                </ul>
            ) }
            <UsageNote usage={ usage } />
        </>
    );
}
