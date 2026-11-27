import { Collapsible, CollapsibleTrigger } from '@clowdy/components/Collapsible';
import { GridListItem } from '@clowdy/components/List';
import { Text } from '@clowdy/components/Text';

import { useProjectState, useProjectUi } from '../../stores';
import { StatusPill } from '../tasks/status';
import { ComposerBanner, ComposerBannerHeader, ComposerBannerList } from './ComposerBanner';
import styles from './TasksBanner.module.css';
import { TASK_REFERENCE_DRAG_TYPE } from './taskReferences';

import type { CSSProperties } from 'react';
import type { ChatProgress } from './progress';

/** The chat's current tasks, kept outside the message history. */
export function TasksBanner({ progress }: { progress: ChatProgress }) {
    const project = useProjectState();
    const ui = useProjectUi();
    const { summary, rows } = progress;
    const continuingBranches = new Set<number>();
    const path: number[] = [];
    const branches = rows.map(({ depth }, index) => {
        // A row at the same depth in the current path is the previous sibling.
        if (path[depth] !== undefined) continuingBranches.add(path[depth]);
        path.length = depth;
        path.push(index);

        return path.slice(1);
    });

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
                            <ComposerBannerList
                                label="Tasks in this chat"
                                onAction={id => ui.openTask(id)}
                                onDragStart={event => {
                                    const id = (event.target as HTMLElement).closest<HTMLElement>(
                                        '[data-reference-task]'
                                    )?.dataset.referenceTask;
                                    const task = rows.find(row => row.task.id === id)?.task;
                                    if (!task) return;
                                    event.dataTransfer.setData(
                                        TASK_REFERENCE_DRAG_TYPE,
                                        JSON.stringify({ key: task.key, title: task.title })
                                    );
                                    event.dataTransfer.effectAllowed = 'copy';
                                }}
                            >
                                {rows.map(({ task, depth, hasChildren }, index) => {
                                    const status = project.statuses.find(status => status.id === task.statusId);
                                    const label = `${task.key} ${task.title}, ${status?.name ?? 'Unknown'}`;

                                    return (
                                        <GridListItem
                                            id={task.id}
                                            data-reference-task={task.id}
                                            ref={node => {
                                                if (node) node.draggable = true;
                                            }}
                                            key={task.id}
                                            className={styles.row}
                                            data-depth={depth}
                                            data-has-children={hasChildren || undefined}
                                            style={{ '--depth': depth } as CSSProperties}
                                            textValue={label}
                                            aria-label={`${label}, level ${depth + 1}`}
                                            endAffix={<StatusPill status={status} />}
                                        >
                                            <Text slot="label" title={task.title}>
                                                {branches[index].map((branch, column) => {
                                                    const current = column === depth - 1;
                                                    const continues = continuingBranches.has(branch);

                                                    if (!current && !continues) return null;

                                                    const kind = current ? (continues ? 'tee' : 'end') : 'through';

                                                    return (
                                                        <span
                                                            key={rows[branch].task.id}
                                                            aria-hidden
                                                            className={styles.guide}
                                                            data-branch={kind}
                                                            style={{ '--column': column } as CSSProperties}
                                                        />
                                                    );
                                                })}
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
