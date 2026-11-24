import { Button } from '@clowdy/components/Button';
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Spinner } from '@clowdy/components/Spinner';
import { Text } from '@clowdy/components/Text';
import { Tooltip } from '@clowdy/components/Tooltip';
import { ArrowDown, ArrowDownRight, ArrowUp, ArrowUpRight, ChevronDown, Refresh, Vsc } from '@clowdy/icons/14';
import { useState } from 'react';

import { Unavailable } from '../../shared/Unavailable';
import { useNow } from '../../shared/useNow';
import { useRootStore } from '../../stores';
import { MERGE_LABELS, openBranchMergeDialog } from './BranchMergeDialog';
import { CommitCountBadge } from './CommitCountBadge';
import {
    commitsWords,
    isFetchFirst,
    type RemoteActionId,
    remoteActions,
    type SyncView,
    syncButton,
    updateFromBase,
} from './changesActions';
import styles from './RemoteMenu.module.css';
import { useRemoteActions } from './useRemoteActions';

import type { ReactNode } from 'react';
import type { PlaceFacts } from './gitFacts';

/** Icons for the origin actions. Publishing sends the branch up as pushing does. */
const ICONS: Record<Exclude<RemoteActionId, 'update' | 'abort'>, ReactNode> = {
    fetch: <Refresh />,
    pull: <ArrowDown />,
    push: <ArrowUp />,
    publish: <ArrowUp />,
};

/** How many commits each way, as the arrows GitHub Desktop draws beside its button: up for what the branch has, down for what origin has. */
function Counts({ ahead, behind }: Pick<SyncView, 'ahead' | 'behind'>) {
    if (!ahead && !behind) return null;

    return (
        <span className={styles.counts} aria-hidden="true">
            {ahead ? (
                <span className={styles.count}>
                    <ArrowUp size={10} />
                    {ahead}
                </span>
            ) : null}
            {behind ? (
                <span className={styles.count}>
                    <ArrowDown size={10} />
                    {behind}
                </span>
            ) : null}
        </span>
    );
}

type SyncCopy = Pick<SyncView, 'label' | 'line' | 'tone'>;

function SyncWords({ label, line, tone }: SyncCopy) {
    const [copy, setCopy] = useState<{ current: SyncCopy; outgoing?: SyncCopy }>({ current: { label, line, tone } });
    const { current, outgoing } = copy;

    if (current.label !== label || current.line !== line || current.tone !== tone) {
        // Keep the latest subtitle, but don't replay the transition when only the fetch clock ticks.
        setCopy({ current: { label, line, tone }, outgoing: current.label === label ? outgoing : current });
    }

    const words = ({ label, line, tone }: SyncCopy) => (
        <>
            <Text variant="xs" weight="medium" color={tone === 'warning' ? 'warning' : undefined} truncate>
                {label}
            </Text>
            {line && (
                <Text
                    variant="xs"
                    color={tone === 'warning' ? 'warning' : 'secondary'}
                    truncate
                    className={styles.line}
                >
                    {line}
                </Text>
            )}
        </>
    );

    return (
        <span className={styles.words}>
            <span key={label} className={styles.copy} data-sync-copy data-entering={!!outgoing || undefined}>
                {words({ label, line, tone })}
            </span>
            {outgoing && (
                <span
                    key={outgoing.label}
                    className={styles.copy}
                    data-outgoing
                    aria-hidden="true"
                    onAnimationEnd={() => setCopy(copy => ({ current: copy.current }))}
                >
                    {words(outgoing)}
                </span>
            )}
        </span>
    );
}

/**
 * The one button that moves the branch: its label is Publish, Pull or Push when the branch needs to sync. Otherwise it shows `Update from <base>` if the base is ahead, or `Fetch origin`.
 * Under the label is when the last fetch was (`Last fetched 3 minutes ago`, `Never fetched`) or the one thing to know of the state. A branch that diverged is `Pull origin`: the pull merges. It is
 * `syncButton`'s rule. While an action runs the label is its progress with a spinner, and nothing can be pressed; where there is nothing to press (no origin, no branch) it is off, and its
 * tooltip says why. The dropdown keeps the other actions, with Fetch first. When the base is ahead but an upstream action has priority, Update sits below the split button.
 * Git failures remain selectable and a push rejected for newer commits offers Fetch. Status and the pull request are read again when an action ends.
 */
export function RemoteMenu({ facts }: { facts: PlaceFacts }) {
    const { transport } = useRootStore();
    const remote = useRemoteActions(facts);
    const now = useNow();
    const status = facts.status.value;
    const idleView = syncButton(status, undefined, now);
    const view = remote.running === undefined ? idleView : syncButton(status, remote.running, now);

    if (!view) return null;

    const actions = remoteActions(status, remote.busy);
    const update = updateFromBase(status);
    const { running, failure, notice } = remote;
    const off = view.action === undefined && running === undefined;
    const current = status?.isRepository && status.head.kind === 'branch' ? status.head.name : undefined;
    const hasOrigin = status?.isRepository === true && status.origin;
    const updateCount = update ? `${commitsWords(update.behind)} to merge from the base` : undefined;
    const updateTooltip = update && `${update.label} · ${updateCount}`;
    const tooltip = view.kind === 'update' ? updateTooltip : view.title;

    const run = (key: string) => {
        if (key === 'merge-from' || key === 'merge-into') {
            if (current !== undefined && !remote.busy) {
                openBranchMergeDialog({
                    transport,
                    remote,
                    placeKey: facts.key,
                    current,
                    direction: key === 'merge-from' ? 'from' : 'into',
                    hasOrigin,
                });
            }
        } else {
            void remote.run(key as RemoteActionId);
        }
    };

    return (
        <div className={styles.root}>
            <div className={styles.split}>
                <Unavailable label={view.label} hint={off ? view.title : undefined} className={styles.host}>
                    <Tooltip
                        content={off || running !== undefined ? undefined : tooltip}
                        isDisabled={off || running !== undefined}
                        placement="bottom"
                    >
                        <Button
                            variant="filled"
                            color="secondary"
                            size="sm"
                            className={styles.main}
                            contentClassName={styles.content}
                            isDisabled={off}
                            isPending={running !== undefined}
                            spinnerPlacement="none"
                            aria-label={view.title}
                            aria-description={view.kind === 'update' ? updateCount : undefined}
                            data-sync={view.kind}
                            onPress={() => view.action && void remote.run(view.action)}
                        >
                            <SyncWords label={view.label} line={view.line} tone={view.tone} />
                            {view.kind === 'update' && update ? (
                                <CommitCountBadge direction="down" count={update.behind} />
                            ) : (
                                <Counts ahead={view.ahead} behind={view.behind} />
                            )}
                            {running !== undefined && <Spinner size="xxs" className={styles.spinner} aria-hidden />}
                        </Button>
                    </Tooltip>
                </Unavailable>

                <MenuTrigger>
                    <Button
                        variant="filled"
                        color="secondary"
                        size="sm"
                        iconOnly
                        className={styles.more}
                        aria-label="More source control actions"
                        tooltip="Source control actions"
                        tooltipPlacement="bottom"
                    >
                        <ChevronDown aria-hidden="true" />
                    </Button>
                    <Popover placement="bottom end" spacing="xs" width={220}>
                        <Menu aria-label="Source control actions" size="sm" onAction={key => run(String(key))}>
                            {actions.map(action => (
                                <MenuItem
                                    key={action.id}
                                    id={action.id}
                                    icon={ICONS[action.id]}
                                    text={action.label}
                                    endAffix={
                                        action.count !== undefined ? (
                                            <Text variant="xs" color="secondary">
                                                {commitsWords(action.count)}
                                            </Text>
                                        ) : undefined
                                    }
                                    isDisabled={action.disabled}
                                />
                            ))}
                            <MenuSeparator />
                            {update && (
                                <MenuItem
                                    id="update"
                                    icon={<Vsc />}
                                    text={update.label}
                                    isDisabled={!hasOrigin || remote.busy}
                                />
                            )}
                            <MenuItem
                                id="merge-from"
                                icon={<ArrowDownRight />}
                                text={MERGE_LABELS.from}
                                isDisabled={current === undefined || remote.busy}
                            />
                            <MenuItem
                                id="merge-into"
                                icon={<ArrowUpRight />}
                                text={MERGE_LABELS.into}
                                isDisabled={current === undefined || remote.busy}
                            />
                        </Menu>
                    </Popover>
                </MenuTrigger>
            </div>

            {update && hasOrigin && idleView?.kind !== 'update' && (
                <Button
                    variant="bordered"
                    size="sm"
                    className={styles.update}
                    contentClassName={styles.content}
                    isDisabled={remote.busy}
                    aria-label={update.label}
                    aria-description={updateCount}
                    tooltip={updateTooltip}
                    tooltipPlacement="bottom"
                    onPress={() => void remote.run('update')}
                >
                    <Text truncate>{update.label}</Text>
                    <CommitCountBadge direction="down" count={update.behind} />
                </Button>
            )}

            {failure && (
                <div className={styles.failure} role="alert">
                    <Text variant="xs" color="danger" select="text">
                        {failure.message}
                    </Text>
                    {failure.hint && (
                        <Text variant="xs" color="secondary" select="text">
                            {failure.hint}
                        </Text>
                    )}
                    {isFetchFirst(failure.message) && (
                        <Button
                            variant="bordered"
                            color="secondary"
                            size="xs"
                            className={styles.fetch}
                            isDisabled={remote.busy}
                            onPress={() => void remote.run('fetch')}
                        >
                            Fetch origin
                        </Button>
                    )}
                </div>
            )}
            {!failure && notice && !(notice.tone === 'warning' && status?.isRepository && status.merging) && (
                <Text
                    variant="xs"
                    color={notice.tone === 'warning' ? 'warning' : 'secondary'}
                    role="status"
                    select="text"
                >
                    {notice.words}
                </Text>
            )}
        </div>
    );
}
