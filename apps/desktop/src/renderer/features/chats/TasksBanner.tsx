import { Collapsible, CollapsibleTrigger } from '@clowdy/components/Collapsible';
import { GridListItem } from '@clowdy/components/List';
import { Text } from '@clowdy/components/Text';

import { useProjectState, useProjectUi } from '../../stores';
import { StatusPill } from '../tasks/status';
import { ComposerBanner, ComposerBannerHeader, ComposerBannerList } from './ComposerBanner';
import styles from './TasksBanner.module.css';

import type { CSSProperties } from 'react';
import type { ChatProgress } from './progress';

/** The chat's current tasks, kept outside the message history. */
export function TasksBanner({ progress }: { progress: ChatProgress }) {
    const project = useProjectState();
    const ui = useProjectUi();
    const { summary, rows } = progress;

    return (
        <ComposerBanner role="group" aria-label="Chat tasks">
            <Collapsible as="Fragment" defaultOpen={false}>
                {({ state }) => (
                    <>
                        <CollapsibleTrigger asChild>
                            <ComposerBannerHeader
                                className={styles.header}
                                contentClassName={styles.headerContent}
                                expanded={state.isExpanded}
                                summary={
                                    <Text variant="xs" color="secondary" className={styles.summary}>
                                        {summary}
                                    </Text>
                                }
                            >
                                Tasks
                            </ComposerBannerHeader>
                        </CollapsibleTrigger>
                        {state.isExpanded && (
                            <ComposerBannerList label="Tasks in this chat" onAction={id => ui.openTask(id)}>
                                {rows.map(({ task, depth }) => {
                                    const status = project.statuses.find(status => status.id === task.statusId);
                                    const label = `${task.key} ${task.title}, ${status?.name ?? 'Unknown'}`;

                                    return (
                                        <GridListItem
                                            id={task.id}
                                            key={task.id}
                                            className={styles.row}
                                            data-depth={depth}
                                            style={{ '--depth': depth } as CSSProperties}
                                            textValue={label}
                                            aria-label={`${label}, level ${depth + 1}`}
                                            endAffix={<StatusPill status={status} />}
                                        >
                                            <Text slot="label" title={task.title}>
                                                <Text variant="xs" color="secondary" className={styles.key}>
                                                    {task.key}
                                                </Text>
                                                <Text variant="xs">{task.title}</Text>
                                            </Text>
                                        </GridListItem>
                                    );
                                })}
                            </ComposerBannerList>
                        )}
                    </>
                )}
            </Collapsible>
        </ComposerBanner>
    );
}
