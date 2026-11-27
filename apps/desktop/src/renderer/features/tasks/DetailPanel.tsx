import { Button } from '@clowdy/components/Button';
import { Chip } from '@clowdy/components/Chip';
import { ConfirmButton } from '@clowdy/components/ConfirmButton';
import { ListBoxItem } from '@clowdy/components/List';
import { openConfirmModal } from '@clowdy/components/modals';
import { Select } from '@clowdy/components/Select';
import { Text } from '@clowdy/components/Text';
import { Archive, ArrowUpRight, Box, Close, Layers } from '@clowdy/icons/14';
import { type Ref, useState } from 'react';

import { commandTooltip } from '../../hotkeys';
import { useRunLabel } from '../../shared';
import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { openChat, openRun as openRunInAgents } from '../chats/archiveChat';
import { archiveTasks } from './archiveActions';
import { archiveWording, openWork } from './archiveRules';
import { CommentsSection } from './CommentsSection';
import { sendCommand, startTask } from './commands';
import { DependencyList } from './DependencyList';
import { DescriptionField } from './DescriptionField';
import styles from './DetailPanel.module.css';
import { Executors, LatestActivity, RelatedChats, Results, Section } from './DetailSections';
import { EditableText } from './EditableText';
import { ParentRow } from './ParentRow';
import { SubtasksSection } from './SubtasksSection';
import { StatusIcon } from './status';
import { ChecklistChip } from './TaskChips';
import { taskNav } from './taskNav';
import { checklistOf, parentCandidates, type TaskTree } from './taskTree';
import { sendWithUndo } from './taskUndo';
import { activeExecutors, dependencyCandidates, externalLink, startBlockedReason, taskActivity } from './taskView';
import { useTaskReadings } from './useTaskReadings';

import type { Run, Task } from '@clowdy/protocol';
import type { CommandInput } from '../../daemon/transport';

export interface DetailPanelProps {
    task: Task;
    /** The runs assigned to the task. */
    taskRuns: readonly Run[];
    /** The title field, for the rename key to put the keyboard in. */
    titleRef?: Ref<HTMLTextAreaElement | null>;
    /** Shows the task's own scope. Given only for a task that has tasks inside it, and then the panel offers "Open sub-tasks". */
    onOpenSubtasks?: () => void;
    /** The project's tasks as a tree: the task's parent and the tasks directly inside it, and how far the work inside it has come. */
    tree: TaskTree;
    /** Opens the "New task" dialog for a task inside this one. */
    onCreateSubtask: () => void;
}

type TaskChanges = Partial<
    Pick<
        Extract<CommandInput, { type: 'task.update' }>,
        'title' | 'description' | 'statusId' | 'dependsOn' | 'parentId'
    >
>;

/**
 * The selected task, on the right of the section: edit it, see where it sits (its parent and the tasks inside it), who works on it and what came out, read and write
 * its comments, start, archive or delete it. This only puts the pieces together and gives each its commands.
 */
export function DetailPanel({ task, taskRuns, titleRef, onOpenSubtasks, tree, onCreateSubtask }: DetailPanelProps) {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const labelOf = useRunLabel();
    const nav = taskNav(root, project, ui, { reveal: true });
    const [isStarting, setIsStarting] = useState(false);
    // A dependency that is archived is not on the board: it is read, and shown as one that is done.
    const { readings: dependencies } = useTaskReadings(task.dependsOn);

    const status = project.statuses.find(candidate => candidate.id === task.statusId);
    const blocked = startBlockedReason(taskRuns, labelOf);
    const link = externalLink(task.external);
    const checklist = checklistOf(task);

    // The panel's edits (title, description, status, dependencies, parent) are the ones the person can take back.
    const update = async (changes: TaskChanges) =>
        (await sendWithUndo(root, project, [{ type: 'task.update', taskId: task.id, ...changes }]))[0].ok;

    const start = async () => {
        setIsStarting(true);
        await startTask(root, task.id);
        setIsStarting(false);
    };

    const openRun = (runId: string) => void openRunInAgents(root, project, ui, runId);

    // A closed task goes to the archive with everything inside it; one with open work asks first, and says how many open tasks it cancels.
    const { action: archiveLabel } = archiveWording([task], openWork(task, tree, project.statuses).length > 0);
    const archive = () =>
        archiveTasks({ root, project, ui: nav, confirm: options => openConfirmModal(options) }, [task]);

    const remove = async () => {
        const result = await sendCommand(root, { type: 'task.delete', taskId: task.id });

        if (result.ok) nav.openTask(null);
    };

    return (
        <aside className={styles.panel} aria-label={`Task ${task.key}`}>
            <div className={styles.head}>
                <Chip icon={<Box width={12} height={12} />}>{task.key}</Chip>
                <Button
                    iconOnly
                    size="sm"
                    variant="filling"
                    aria-label="Close"
                    tooltip="Close"
                    onPress={() => nav.openTask(null)}
                >
                    <Close />
                </Button>
            </div>

            <div className={styles.body}>
                <div className={styles.top}>
                    <EditableText
                        ref={titleRef}
                        variant="title"
                        aria-label="Title"
                        required
                        value={task.title}
                        onCommit={title => update({ title })}
                    />
                    {checklist && (
                        <div className={styles.chips}>
                            <ChecklistChip checklist={checklist} />
                        </div>
                    )}
                    <Select
                        aria-label="Status"
                        size="sm"
                        variant="bordered"
                        className={styles.status}
                        popoverClassName={styles.statusList}
                        icon={status && <StatusIcon category={status.category} />}
                        items={project.statuses}
                        selectedKey={task.statusId}
                        onSelectionChange={(key: unknown) =>
                            typeof key === 'string' && key !== task.statusId && void update({ statusId: key })
                        }
                    >
                        {item => (
                            <ListBoxItem id={item.id} text={item.name} icon={<StatusIcon category={item.category} />} />
                        )}
                    </Select>
                    <DescriptionField value={task.description} onSave={description => update({ description })} />
                    {onOpenSubtasks && (
                        <Button
                            variant="bordered"
                            size="sm"
                            className={styles.subtasks}
                            tooltip={commandTooltip('Open sub-tasks', 'tasks.subtasks.open')}
                            onPress={onOpenSubtasks}
                        >
                            <Layers />
                            Open sub-tasks
                        </Button>
                    )}
                </div>

                <ParentRow
                    task={task}
                    parent={tree.parentOf(task)}
                    candidates={parentCandidates(project.taskList, task)}
                    statuses={project.statuses}
                    onOpen={id => nav.openTask(id)}
                    onChange={parentId => void update({ parentId })}
                />

                <SubtasksSection
                    task={task}
                    subtasks={tree.childrenOf(task.id)}
                    rollUp={tree.rollUp(task)}
                    statuses={project.statuses}
                    canHaveChildren={tree.canHaveChildren(task)}
                    onOpen={id => nav.openTask(id)}
                    onCreate={onCreateSubtask}
                />

                <Executors taskRuns={taskRuns} onOpen={openRun} />

                <Section title="Dependencies" count={task.dependsOn.length}>
                    <DependencyList
                        ids={task.dependsOn}
                        tasks={project.tasks}
                        readings={dependencies}
                        statuses={project.statuses}
                        candidates={dependencyCandidates(project.taskList, { taskId: task.id, taken: task.dependsOn })}
                        onAdd={id => void update({ dependsOn: [...task.dependsOn, id] })}
                        onRemove={id =>
                            void update({ dependsOn: task.dependsOn.filter(candidate => candidate !== id) })
                        }
                        onOpen={id => nav.openTask(id)}
                    />
                </Section>

                <RelatedChats
                    chats={project.chatsOfTask(task.id)}
                    onOpen={chatId => void openChat(root, project, ui, chatId)}
                />

                <Results
                    taskId={task.id}
                    expectChecks={activeExecutors(taskRuns).length > 0}
                    onOpenDoc={path => nav.openDoc(path)}
                />

                <LatestActivity activity={taskActivity(task, taskRuns, project.runs, labelOf)} />

                <CommentsSection taskId={task.id} onOpenRun={openRun} onOpenTask={id => nav.openTask(id)} />
            </div>

            <div className={styles.foot}>
                {blocked && <Text color="secondary">{blocked}</Text>}
                <div className={styles.actions}>
                    {/* The keys act on the cursor task, which is this one while the panel follows the cursor. A task that cannot start has no hint (the command is off). */}
                    <Button
                        color="primary"
                        size="sm"
                        isDisabled={blocked !== null}
                        isPending={isStarting}
                        tooltip={commandTooltip('Start with an agent', 'tasks.start')}
                        onPress={() => void start()}
                    >
                        Start
                    </Button>
                    {link && (
                        <Button variant="bordered" size="sm" href={link.url} target="_blank" rel="noreferrer">
                            {`Open in ${link.label}`}
                            <ArrowUpRight />
                        </Button>
                    )}
                    <span className={styles.spacer} />
                    <Button
                        variant="bordered"
                        size="sm"
                        tooltip={commandTooltip(archiveLabel, 'tasks.archive')}
                        onPress={archive}
                    >
                        <Archive />
                        {archiveLabel}
                    </Button>
                    <ConfirmButton
                        variant="filling"
                        color="danger"
                        size="sm"
                        confirmColor="danger"
                        confirmVariant="filled"
                        tooltip={commandTooltip('Delete task', 'tasks.delete')}
                        onConfirm={remove}
                    >
                        Delete
                    </ConfirmButton>
                </div>
            </div>
        </aside>
    );
}
