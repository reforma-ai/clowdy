import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { Box, Close, Undo } from '@clowdy/icons/14';
import { useState } from 'react';

import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { Markdown } from '../../stream/Markdown';
import { StreamLinksContext, type StreamLinks } from '../../stream/StreamLinks';
import { openRun as openRunInAgents } from '../chats/archiveChat';
import { restoreTask } from './archiveActions';
import { offersRestore } from './archiveBatches';
import styles from './ArchivedPanel.module.css';
import { CommentsSection } from './CommentsSection';
import { DependencyList } from './DependencyList';
import panelStyles from './DetailPanel.module.css';
import { None, Section } from './DetailSections';
import { Pill, PillLabel } from './Pill';
import { StatusIcon, StatusPill } from './status';
import { ChecklistChip } from './TaskChips';
import { taskNav } from './taskNav';
import { checklistOf } from './taskTree';
import { formatAgo } from './taskView';
import { useTaskById, useTaskReadings } from './useTaskReadings';

import type { Task } from '@clowdy/protocol';

export interface ArchivedPanelProps {
    task: Task;
}

/**
 * An archived task in the place of the detail panel: what it said when it was archived, read only, with its archive status and **Restore**. It has no fields to edit,
 * no start and no sub-tasks (the archive's own view draws the tree). Restore is offered only when the task has no parent or its parent is on the board, since the daemon
 * refuses a task whose parent is still archived: the panel then says which task to restore first. Its parent and dependencies and the keys in its text open as everywhere, an archived task too.
 */
export function ArchivedPanel({ task }: ArchivedPanelProps) {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const nav = taskNav(root, project, ui, { reveal: true });
    const { reading: parent } = useTaskById(task.parentId ?? null);
    const { readings: dependencies } = useTaskReadings(task.dependsOn);
    const [isRestoring, setIsRestoring] = useState(false);

    const status = project.statuses.find(candidate => candidate.id === task.statusId);
    const checklist = checklistOf(task);
    const above = parent.status === 'ready' ? parent.task : undefined;
    const aboveStatus = project.statuses.find(candidate => candidate.id === above?.statusId);
    // The daemon takes a restore only when the task has no parent or its parent is on the board, so it is not offered while the parent is archived, whether with this task or in a later batch.
    const canRestore = offersRestore(task, id => project.tasks.has(id));
    // A key in the description is a chip that opens the task, as in a comment.
    const links: StreamLinks = { taskOfKey: key => project.taskOfKey(key), onOpenTask: id => nav.openTask(id) };

    // The agent that wrote a comment opens in Agents, as it does from the panel of a task on the board.
    const openRun = (runId: string) => void openRunInAgents(root, project, ui, runId);

    const restore = async () => {
        setIsRestoring(true);
        await restoreTask(root, project, task);
        setIsRestoring(false);
    };

    return (
        <aside className={ panelStyles.panel } aria-label={ `Task ${ task.key }` } data-archived>
            <div className={ panelStyles.head }>
                <span className={ panelStyles.key }>
                    <Box aria-hidden width={ 12 } height={ 12 } />
                    { task.key }
                </span>
                <Button iconOnly size="sm" variant="filling" aria-label="Close" tooltip="Close" onPress={ () => nav.openTask(null) }>
                    <Close />
                </Button>
            </div>

            <div className={ panelStyles.body }>
                <div className={ panelStyles.top }>
                    <Text variant="heading-3" className={ styles.title }>{ task.title }</Text>
                    <div className={ styles.state }>
                        <Pill><PillLabel>Archived</PillLabel></Pill>
                        <StatusPill status={ status } />
                        { checklist && <ChecklistChip checklist={ checklist } /> }
                    </div>
                    { task.archivedAt !== undefined && <Text color="secondary">{ `Archived ${ formatAgo(task.archivedAt, Date.now()) }` }</Text> }
                    { task.description !== '' && (
                        <StreamLinksContext value={ links }>
                            <Markdown text={ task.description } />
                        </StreamLinksContext>
                    ) }
                </div>

                <Section title="Parent">
                    { task.parentId === undefined && <None>No parent</None> }
                    { task.parentId !== undefined && parent.status === 'loading' && <None>Loading…</None> }
                    { task.parentId !== undefined && parent.status === 'failed' && <None>{ 'Couldn\'t read the parent' }</None> }
                    { task.parentId !== undefined && parent.status === 'missing' && <None>The parent was removed</None> }
                    { above && (
                        <button type="button" className={ styles.parent } title={ above.title } onClick={ () => nav.openTask(above.id) }>
                            { aboveStatus && <StatusIcon category={ aboveStatus.category } /> }
                            <span className={ styles.key }>{ above.key }</span>
                            <span className={ styles.parentTitle }>{ above.title }</span>
                            { above.archivedAt !== undefined && <span className={ styles.key }>Archived</span> }
                        </button>
                    ) }
                </Section>

                <Section title="Dependencies" count={ task.dependsOn.length }>
                    { task.dependsOn.length === 0 && <None>No dependencies</None> }
                    { task.dependsOn.length > 0 && (
                        <DependencyList
                            ids={ task.dependsOn }
                            tasks={ project.tasks }
                            readings={ dependencies }
                            statuses={ project.statuses }
                            candidates={ [] }
                            isReadOnly
                            onAdd={ () => undefined }
                            onRemove={ () => undefined }
                            onOpen={ id => nav.openTask(id) }
                        />
                    ) }
                </Section>

                <CommentsSection taskId={ task.id } isReadOnly onOpenRun={ openRun } onOpenTask={ id => nav.openTask(id) } />
            </div>

            <div className={ panelStyles.foot }>
                { !canRestore && above && (
                    <Text color="secondary">
                        { above.archivedAt === task.archivedAt ? `It was archived with ${ above.key }. Restore ${ above.key } to bring it back.` : `Its parent ${ above.key } is in the archive, restore it first` }
                    </Text>
                ) }
                <div className={ panelStyles.actions }>
                    <Button
                        color="primary"
                        size="sm"
                        isDisabled={ !canRestore }
                        isPending={ isRestoring }
                        onPress={ () => void restore() }
                    >
                        <Undo />
                        Restore
                    </Button>
                </div>
            </div>
        </aside>
    );
}
