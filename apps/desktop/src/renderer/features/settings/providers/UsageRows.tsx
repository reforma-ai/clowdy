import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { Refresh } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';

import { formatRemaining } from '../../../shared';
import { InlineCode } from './InlineCode';
import { usageTone, windowPercent } from './providerView';
import styles from './UsageRows.module.css';

import type { AgentUsage, AgentUsageWindow } from '@clowdy/protocol';

/** `Resets in 11m`, or `Resets now` for a window whose time has come (`formatRemaining` says `now` for under a minute). */
function resetText(window: AgentUsageWindow, now: number): string | undefined {
    if (window.resetsAt === undefined) return undefined;

    const remaining = formatRemaining(window.resetsAt - now);

    return remaining === 'now' ? 'Resets now' : `Resets in ${ remaining }`;
}

/**
 * One window: its label with how much is used, when it resets at the far end, and the bar under them. The bar turns warning at 80% and
 * danger at 90% (`usageTone`).
 */
function UsageRow({ window, now }: { window: AgentUsageWindow; now: number }) {
    const percent = windowPercent(window);
    const tone = usageTone(percent);
    const reset = resetText(window, now);

    return (
        <li className={ styles.row }>
            <div className={ styles.details }>
                <Text variant="sm" weight="medium" truncate className={ styles.label } title={ window.label }>{ window.label }</Text>
                <Text variant="sm" color="secondary" className={ styles.figure }>{ `${ percent }% used` }</Text>
                { reset && <Text variant="sm" color="secondary" className={ cn(styles.figure, styles.reset) } title="Time until the window resets">{ reset }</Text> }
            </div>
            <div className={ styles.track } role="progressbar" aria-label={ `${ window.label } used` } aria-valuemin={ 0 } aria-valuemax={ 100 } aria-valuenow={ percent } aria-valuetext={ `${ percent }%` }>
                <div className={ styles.fill } data-tone={ tone === 'normal' ? undefined : tone } style={ { width: `${ percent }%` } } />
            </div>
        </li>
    );
}

export interface RefreshUsageButtonProps {
    /** A read is on its way. */
    isRefreshing: boolean;
    onRefresh: () => void;
    /** `xs` (the default) at the end of a line of text, `sm` beside other `sm` buttons. */
    size?: 'xs' | 'sm';
    className?: string;
}

/** The button that reads the usage again: an icon that gets a fill under the pointer, and turns while a read is on its way. */
export function RefreshUsageButton({ isRefreshing, onRefresh, size = 'xs', className }: RefreshUsageButtonProps) {
    return (
        <Button variant="filling" color="secondary" size={ size } iconOnly aria-label="Refresh usage" tooltip="Refresh usage" isPending={ isRefreshing } spinnerPlacement="none" className={ className } onPress={ onRefresh }>
            <Refresh className={ isRefreshing ? styles.spin : undefined } />
        </Button>
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
}

/**
 * What a provider's usage says, shared by the Providers page and the window header's popover: a bar per window, in the order the daemon lists them (the nearest first; the last good
 * reading, faded, when the newest read failed) and, under them, the daemon's own words when there is something to explain.
 */
export function UsageReading({ usage, now }: UsageReadingProps) {
    return (
        <>
            { usage.windows.length > 0 && (
                <ul className={ styles.rows } data-stale={ usage.state === 'error' || undefined }>
                    { usage.windows.map(window => <UsageRow key={ window.id } window={ window } now={ now } />) }
                </ul>
            ) }
            <UsageNote usage={ usage } />
        </>
    );
}
