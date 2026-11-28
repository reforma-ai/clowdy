import { Button } from '@clowdy/components/Button';
import { Menu, MenuItem, MenuSeparator } from '@clowdy/components/List';
import { Spinner } from '@clowdy/components/Spinner';
import { SplitButton } from '@clowdy/components/SplitButton';
import { Text } from '@clowdy/components/Text';
import { ArrowDown, ArrowDownRight, ArrowUp, ArrowUpRight, Merge, MergeInto, Refresh } from '@clowdy/icons/14';
import { useId, useState } from 'react';

import { useNow } from '../../shared/useNow';
import { useRootStore } from '../../stores';
import { MERGE_LABELS, openBranchMergeDialog } from './BranchMergeDialog';
import { CommitCountBadge } from './CommitCountBadge';
import { commitsWords, isFetchFirst, remoteActions, type SyncView, syncButton, updateFromBase } from './changesActions';
import styles from './RemoteMenu.module.css';
import { useRemoteActions } from './useRemoteActions';

import type { ReactNode } from 'react';
import type { PlaceFacts } from './gitFacts';

const ICONS: Record<'fetch' | 'pull' | 'push', ReactNode> = {
    fetch: <Refresh />,
    pull: <ArrowDown />,
    push: <ArrowUp />,
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
 * One split button recommends the next action. Its menu keeps explicit Fetch, Pull, Update and branch merges available.
 */
export function RemoteMenu({ facts, checkoutBranch }: { facts: PlaceFacts; checkoutBranch?: string }) {
    const { transport } = useRootStore();
    const remote = useRemoteActions(facts);
    const now = useNow();
    const detailId = useId();
    const status = facts.status.value;
    const view = syncButton(status, remote.running, now, remote.syncPhase);

    if (!view) return null;

    const actions = remoteActions(status, facts.switching);
    const update = updateFromBase(status);
    const { running, failure, notice } = remote;
    const off = running === undefined && (view.action === undefined || facts.switching);
    const offHint = facts.switching ? 'The branch is being changed' : view.title;
    const current = status?.isRepository && status.head.kind === 'branch' ? status.head.name : undefined;
    const destination = facts.key.workspaceId && checkoutBranch !== current ? checkoutBranch : undefined;
    const hasOrigin = status?.isRepository === true && status.origin;
    const updateBlocked = !hasOrigin || facts.switching || remote.isPending('update');
    const tip = off || running !== undefined ? undefined : view.title;
    const detail = off ? undefined : (tip ?? view.line);
    const sync = () => {
        if (current !== undefined) void remote.sync({ branch: current });
    };

    const run = (key: string) => {
        if (key === 'merge-from' || key === 'merge-into' || key === 'merge-into-checkout') {
            if (key === 'merge-into-checkout' && !destination) return;
            if (current !== undefined && !facts.switching) {
                openBranchMergeDialog({
                    transport,
                    remote,
                    placeKey: facts.key,
                    current,
                    direction: key === 'merge-from' ? 'from' : 'into',
                    hasOrigin,
                    ...(key === 'merge-into-checkout' && { checkoutBranch: destination }),
                });
            }
        } else if (key === 'push') {
            if (!facts.status.loading && !facts.status.stale && status?.isRepository && status.head.kind === 'branch')
                void remote.push({ branch: status.head.name, commit: status.head.commit });
        } else if (key === 'fetch' || key === 'pull' || key === 'update') {
            void remote.run(key);
        }
    };

    return (
        <div className={styles.root} data-sync={view.kind}>
            <SplitButton
                variant="filled"
                color="secondary"
                size="sm"
                wrap
                fullWidth
                contentClassName={styles.content}
                isDisabled={off}
                disabledReason={off ? offHint : undefined}
                isPending={running !== undefined}
                spinnerPlacement="none"
                aria-label={view.label}
                aria-describedby={detail ? detailId : undefined}
                // A tooltip that came and went would remount the button and drop the focus of the person who pressed it, so one with no tip says the label.
                tooltip={tip ?? view.label}
                tooltipPlacement="bottom"
                onPress={() => {
                    if (view.action === 'sync') sync();
                    else if (view.action) void remote.run(view.action);
                }}
                menuLabel="More source control actions"
                menuTooltip="Source control actions"
                menuWidth={220}
                menu={
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
                                isDisabled={
                                    action.disabled ||
                                    (action.id === 'push'
                                        ? remote.busy || facts.status.loading || facts.status.stale
                                        : remote.isPending(action.id))
                                }
                            />
                        ))}
                        <MenuSeparator />
                        {update && (
                            <MenuItem id="update" icon={<Merge />} text={update.label} isDisabled={updateBlocked} />
                        )}
                        <MenuItem
                            id="merge-from"
                            icon={<ArrowDownRight />}
                            text={MERGE_LABELS.from}
                            isDisabled={current === undefined || facts.switching}
                        />
                        <MenuItem
                            id="merge-into"
                            icon={<ArrowUpRight />}
                            text={MERGE_LABELS.into}
                            isDisabled={current === undefined || facts.switching}
                        />
                        {destination && (
                            <MenuItem
                                id="merge-into-checkout"
                                icon={<MergeInto />}
                                text="Merge into main worktree…"
                                isDisabled={current === undefined || facts.switching}
                            />
                        )}
                    </Menu>
                }
            >
                <SyncWords label={view.label} line={view.line} tone={view.tone} />
                {view.kind === 'update' && view.behind ? (
                    <CommitCountBadge direction="down" count={view.behind} />
                ) : (
                    <Counts ahead={view.ahead} behind={view.behind} />
                )}
                {running !== undefined && <Spinner size="xxs" className={styles.spinner} aria-hidden />}
            </SplitButton>
            {detail && (
                <span id={detailId} hidden>
                    {detail}
                </span>
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
                    {failure.action === 'sync' && view.action === 'sync' && isFetchFirst(failure.message) && (
                        <Button
                            variant="bordered"
                            color="secondary"
                            size="xs"
                            className={styles.retry}
                            isDisabled={facts.switching || remote.isPending('sync')}
                            onPress={sync}
                        >
                            Retry Sync
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
