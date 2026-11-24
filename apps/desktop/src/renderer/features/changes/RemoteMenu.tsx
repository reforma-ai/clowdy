import { Button } from '@clowdy/components/Button';
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Spinner } from '@clowdy/components/Spinner';
import { Text } from '@clowdy/components/Text';
import { ArrowDown, ArrowDownRight, ArrowUp, ArrowUpRight, ChevronDown, Refresh, Vsc } from '@clowdy/icons/14';

import { Unavailable } from '../../shared/Unavailable';
import { useNow } from '../../shared/useNow';
import { useRootStore } from '../../stores';
import { MERGE_LABELS, openBranchMergeDialog } from './BranchMergeDialog';
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
                    <ArrowUp />
                    {ahead}
                </span>
            ) : null}
            {behind ? (
                <span className={styles.count}>
                    <ArrowDown />
                    {behind}
                </span>
            ) : null}
        </span>
    );
}

/**
 * The one button that moves the branch, with GitHub Desktop's words: its label is the next action (`Publish branch`, `Pull origin` or `Push origin` with the commits it moves, `Fetch origin`),
 * and under it is when the last fetch was (`Last fetched 3 minutes ago`, `Never fetched`) or the one thing to know of the state. A branch that diverged is `Pull origin`: the pull merges. It is
 * `syncButton`'s rule. While an action runs the label is its progress with a spinner, and nothing can be pressed; where there is nothing to press (no origin, no branch) it is off, and its
 * tooltip says why. The words are cut by the sidebar's edge, narrow as it is dragged: the tooltip has all of them. Beside it a dropdown keeps every action with the reason it cannot run
 * (`remoteActions`: nothing to pull, nothing to push, not published, pull first, no origin), Fetch origin first and always. When an action ends a quiet line
 * says what it did, or git's own line says why it could not (selectable, with the hint of the daemon under it, as the commit box does), and a push that origin turned down for commits the
 * branch lacks has a Fetch origin button beside it, as GitHub Desktop's `Newer Commits on Remote` has Fetch. The place's facts, and with them the line against the base, the counts and the
 * pull request, are read again when it ends.
 */
export function RemoteMenu({ facts }: { facts: PlaceFacts }) {
    const { transport } = useRootStore();
    const remote = useRemoteActions(facts);
    const now = useNow();
    const status = facts.status.value;
    const view = syncButton(status, remote.running, now);

    if (!view) return null;

    const actions = remoteActions(status, remote.busy);
    const update = updateFromBase(status);
    const { running, failure, notice } = remote;
    const off = view.action === undefined && running === undefined;
    const current = status?.isRepository && status.head.kind === 'branch' ? status.head.name : undefined;
    const hasOrigin = status?.isRepository === true && status.origin;

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
                        data-sync={view.kind}
                        tooltip={off || running !== undefined ? undefined : view.title}
                        tooltipPlacement="bottom"
                        onPress={() => view.action && void remote.run(view.action)}
                    >
                        <span className={styles.words}>
                            <Text
                                variant="xs"
                                weight="medium"
                                color={view.tone === 'warning' ? 'warning' : undefined}
                                truncate
                            >
                                {view.label}
                            </Text>
                            {view.line && (
                                <Text
                                    variant="xs"
                                    color={view.tone === 'warning' ? 'warning' : 'secondary'}
                                    truncate
                                    className={styles.line}
                                >
                                    {view.line}
                                </Text>
                            )}
                        </span>
                        <Counts ahead={view.ahead} behind={view.behind} />
                        {running !== undefined && <Spinner size="xxs" className={styles.spinner} aria-hidden />}
                    </Button>
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
            {!failure && notice && (
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
