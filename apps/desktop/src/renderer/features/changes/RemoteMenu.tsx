import { Button } from '@clowdy/components/Button';
import { Menu, MenuItem, MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Text } from '@clowdy/components/Text';
import { ChevronDown } from '@clowdy/icons/8';
import { ArrowDown, ArrowUp, Cloud, Refresh } from '@clowdy/icons/14';

import { type RemoteActionId, RUNNING_WORDS, remoteActions, upstreamView } from './changesActions';
import styles from './RemoteMenu.module.css';
import { useRemoteActions } from './useRemoteActions';

import type { ReactNode } from 'react';
import type { PlaceFacts } from './gitFacts';

/** The mark of each entry of the menu. Publishing sends the branch up as pushing does. */
const ICONS: Record<RemoteActionId, ReactNode> = {
    fetch: <Refresh />,
    pull: <ArrowDown />,
    push: <ArrowUp />,
    publish: <ArrowUp />,
};

/**
 * Where the branch stands against its upstream, as a row that opens the menu of what moves it: Fetch, Pull, and Push (or Publish, while the branch is not on origin). The row says the
 * upstream and how far apart the two are (`origin/feature · 1 ahead`, `Not published`, `origin/main · diverged`); an entry that cannot run is listed with the reason under it (nothing to pull,
 * nothing to push, not published, diverged, no origin), which is the rule of `remoteActions`. While an action runs the row says what it is doing and holds its spinner, and under it, when
 * it ends, a quiet line says what it did, or git's own line says why it could not (selectable, with the hint of the daemon under it), as the commit box does. The place's facts, and with
 * them the line against the base, the counts and the pull request, are read again when it ends.
 */
export function RemoteMenu({ facts }: { facts: PlaceFacts }) {
    const remote = useRemoteActions(facts);
    const status = facts.status.value;
    const view = upstreamView(status);

    if (!view) return null;

    const actions = remoteActions(status, remote.busy);
    const { running, failure, notice } = remote;

    return (
        <div className={styles.root}>
            <MenuTrigger>
                <Button
                    variant="filling"
                    color="secondary"
                    size="xs"
                    className={styles.trigger}
                    contentClassName={styles.content}
                    isPending={running !== undefined}
                    spinnerPlacement="start"
                    aria-label={running ? RUNNING_WORDS[running] : `Origin: ${view.title}`}
                    tooltip={running ? undefined : view.title}
                    tooltipPlacement="bottom"
                >
                    {!running && <Cloud aria-hidden="true" className={styles.icon} />}
                    <Text variant="xs" weight="medium" truncate className={styles.label}>
                        {running ? RUNNING_WORDS[running] : view.label}
                    </Text>
                    {!running && view.detail && (
                        <Text
                            variant="xs"
                            color={view.tone === 'warning' ? 'warning' : 'secondary'}
                            className={styles.detail}
                        >
                            {view.detail}
                        </Text>
                    )}
                    <ChevronDown aria-hidden="true" className={styles.chevron} />
                </Button>
                <Popover placement="bottom start" spacing="xs" width={220}>
                    <Menu aria-label="Origin" size="sm" onAction={key => void remote.run(key as RemoteActionId)}>
                        {actions.map(action => (
                            <MenuItem
                                key={action.id}
                                id={action.id}
                                icon={ICONS[action.id]}
                                text={action.label}
                                endAffix={
                                    action.count !== undefined && action.reason === undefined ? (
                                        <Text variant="xs" color="secondary">
                                            {action.count}
                                        </Text>
                                    ) : undefined
                                }
                                description={action.reason}
                                stacked={action.reason !== undefined}
                                isDisabled={action.reason !== undefined}
                            />
                        ))}
                    </Menu>
                </Popover>
            </MenuTrigger>

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
