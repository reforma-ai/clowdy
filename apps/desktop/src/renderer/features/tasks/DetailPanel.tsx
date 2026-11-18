import { Button } from '@clowdy/components/Button';
import { ConfirmButton } from '@clowdy/components/ConfirmButton';
import { ListBoxItem } from '@clowdy/components/List';
import { Select } from '@clowdy/components/Select';
import { Text } from '@clowdy/components/Text';
import { ArrowUpRight, Box, Close } from '@clowdy/icons/14';
import { useState, type Ref } from 'react';

import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { sendCommand, startTask } from './commands';
import { DependencyList } from './DependencyList';
import styles from './DetailPanel.module.css';
import { Executors, LatestActivity, RelatedChats, Results, Section } from './DetailSections';
import { EditableText } from './EditableText';
import { StatusIcon } from './status';
import { activeExecutors, dependencyCandidates, externalLink, startBlockedReason, taskActivity, type TaskRun } from './taskView';

import type { Task } from '@clowdy/protocol';
import type { CommandInput } from '../../daemon/transport';

export interface DetailPanelProps {
    task: Task;
    /** The runs on the task: assigned and verifying ones. */
    taskRuns: readonly TaskRun[];
    /** The title field, for the rename key to put the keyboard in. */
    titleRef?: Ref<HTMLTextAreaElement | null>;
}

type TaskChanges = Partial<Pick<Extract<CommandInput, { type: 'task.update' }>, 'title' | 'description' | 'statusId' | 'dependsOn'>>;

/** The selected task, on the right of the section: edit it, see who works on it and what came out, start or delete it. */
export function DetailPanel({ task, taskRuns, titleRef }: DetailPanelProps) {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const [isStarting, setIsStarting] = useState(false);

    const status = project.statuses.find(candidate => candidate.id === task.statusId);
    const blocked = startBlockedReason(taskRuns);
    const link = externalLink(task.external);

    const update = async (changes: TaskChanges) => (await sendCommand(root, { type: 'task.update', taskId: task.id, ...changes })).ok;

    const start = async () => {
        setIsStarting(true);
        await startTask(root, task.id);
        setIsStarting(false);
    };

    const remove = async () => {
        const result = await sendCommand(root, { type: 'task.delete', taskId: task.id });

        if (result.ok) ui.openTask(null);
    };

    return (
        <aside className={ styles.panel } aria-label={ `Task ${ task.key }` }>
            <div className={ styles.head }>
                <span className={ styles.key }>
                    <Box aria-hidden width={ 12 } height={ 12 } />
                    { task.key }
                </span>
                <Button iconOnly size="sm" variant="filling" aria-label="Close" tooltip="Close" onPress={ () => ui.openTask(null) }>
                    <Close />
                </Button>
            </div>

            <div className={ styles.body }>
                <div className={ styles.top }>
                    <EditableText
                        ref={ titleRef }
                        variant="title"
                        aria-label="Title"
                        required
                        value={ task.title }
                        onCommit={ title => update({ title }) }
                    />
                    <Select
                        aria-label="Status"
                        size="sm"
                        variant="bordered"
                        className={ styles.status }
                        popoverClassName={ styles.statusList }
                        icon={ status && <StatusIcon category={ status.category } /> }
                        items={ project.statuses }
                        selectedKey={ task.statusId }
                        onSelectionChange={ (key: unknown) => typeof key === 'string' && key !== task.statusId && void update({ statusId: key }) }
                    >
                        { item => <ListBoxItem id={ item.id } text={ item.name } icon={ <StatusIcon category={ item.category } /> } /> }
                    </Select>
                    <EditableText
                        variant="body"
                        aria-label="Description"
                        placeholder="Add a description…"
                        value={ task.description }
                        onCommit={ description => update({ description }) }
                    />
                </div>

                <Executors taskRuns={ taskRuns } onOpen={ runId => ui.openRun(runId) } />

                <Section title="Dependencies" count={ task.dependsOn.length }>
                    <DependencyList
                        ids={ task.dependsOn }
                        tasks={ project.tasks }
                        statuses={ project.statuses }
                        candidates={ dependencyCandidates(project.taskList, { taskId: task.id, taken: task.dependsOn }) }
                        onAdd={ id => void update({ dependsOn: [...task.dependsOn, id] }) }
                        onRemove={ id => void update({ dependsOn: task.dependsOn.filter(candidate => candidate !== id) }) }
                        onOpen={ id => ui.openTask(id) }
                    />
                </Section>

                <RelatedChats chats={ project.chatsOfTask(task.id) } onOpen={ chatId => ui.openChat(chatId) } />

                <Results taskId={ task.id } expectChecks={ activeExecutors(taskRuns).length > 0 } onOpenDoc={ path => ui.openDoc(path) } />

                <LatestActivity activity={ taskActivity(task, taskRuns, project.runs) } />
            </div>

            <div className={ styles.foot }>
                { blocked && <Text color="secondary">{ blocked }</Text> }
                <div className={ styles.actions }>
                    <Button color="primary" size="sm" isDisabled={ blocked !== null } isPending={ isStarting } onPress={ () => void start() }>Start</Button>
                    { link && (
                        <Button variant="bordered" size="sm" href={ link.url } target="_blank" rel="noreferrer">
                            { `Open in ${ link.label }` }
                            <ArrowUpRight />
                        </Button>
                    ) }
                    <span className={ styles.spacer } />
                    <ConfirmButton variant="filling" color="danger" size="sm" confirmColor="danger" confirmVariant="filled" onConfirm={ remove }>Delete</ConfirmButton>
                </div>
            </div>
        </aside>
    );
}
