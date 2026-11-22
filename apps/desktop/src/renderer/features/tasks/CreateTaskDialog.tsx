import { Button } from '@clowdy/components/Button';
import { FormField } from '@clowdy/components/FormField';
import { Input } from '@clowdy/components/Input';
import { ListBoxItem } from '@clowdy/components/List';
import { Modal, useModalContext } from '@clowdy/components/Modal';
import { Select } from '@clowdy/components/Select';
import { Text } from '@clowdy/components/Text';
import { Textarea } from '@clowdy/components/Textarea';
import { useId, useState, type FormEvent } from 'react';

import styles from './CreateTaskDialog.module.css';
import { DependencyList } from './DependencyList';
import { NO_PARENT, parentOptions } from './pickerOptions';
import { StatusIcon } from './status';
import { parentCandidates } from './taskTree';
import { createdTaskId, dependencyCandidates } from './taskView';

import type { TaskId } from '@clowdy/protocol';
import type { ProjectState, ProjectUi, RootStore } from '../../stores';

export interface CreateTaskDialogProps {
    root: RootStore;
    project: ProjectState;
    ui: ProjectUi;
    /** Where the dialog starts: the new task is a sub-task of this one, and says so. The person may pick another parent, or none. */
    parentId?: TaskId;
}

/**
 * "New task": title, description, status, parent and dependencies. The new task opens in the detail panel, and the Tasks screen shows it where it is: with a parent the task goes
 * inside that one, and a muted line under the heading names it; the screen keeps its scope when the task is inside it and moves to the task's parent when it is not.
 * The parent starts as `parentId`, and the field changes it or clears it ("No parent" makes a task of the roots); it lists the tasks a new task may go under, which are
 * those with room for another level (`parentCandidates` with no task, since none is being moved).
 * `onClose` runs when the dialog is closed, however it was: the window hands focus back after it, so a caller that wants it elsewhere acts a tick later.
 */
export function openCreateTask(props: CreateTaskDialogProps, { onClose }: { onClose?: () => void } = {}): void {
    Modal.create({
        onClose,
        width: 480,
        shadow: true,
        clickOut: true,
        closeOnEscape: true,
        // No `title` option: the heading is drawn in the form. The window's own close button floats at the corner, and a form dialog stays where it opens.
        closeButton: true,
        handle: false,
        component: <CreateTaskForm { ...props } />,
    });
}

function CreateTaskForm({ root, project, ui, parentId }: CreateTaskDialogProps) {
    const { modal } = useModalContext();
    const descriptionId = useId();
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [statusId, setStatusId] = useState(() => (project.statuses.find(status => status.category === 'todo') ?? project.statuses[0])?.id);
    const [chosenParentId, setChosenParentId] = useState<TaskId | null>(parentId ?? null);
    const [dependsOn, setDependsOn] = useState<string[]>([]);
    const [error, setError] = useState('');
    const [isPending, setIsPending] = useState(false);
    const canSubmit = title.trim() !== '';
    const parent = chosenParentId === null ? undefined : project.tasks.get(chosenParentId);
    const parentStatus = parent && project.statuses.find(status => status.id === parent.statusId);

    const submit = async (event: FormEvent) => {
        event.preventDefault();

        if (!canSubmit || isPending) return;

        setIsPending(true);
        setError('');

        const result = await root.command({
            type: 'task.create',
            projectId: project.id,
            title: title.trim(),
            description: description.trim() || undefined,
            statusId,
            dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
            parentId: chosenParentId ?? undefined,
        });

        if (result.ok) {
            modal.cancel();

            const taskId = createdTaskId(result.data);

            // The daemon's event may come after this reply, so the new task is not always in the project yet: `madeIn` puts the screen where it will show.
            if (taskId) ui.openTask(taskId, { madeIn: chosenParentId });
        }
        else {
            setError(result.error.message);
        }

        setIsPending(false);
    };

    return (
        <form className={ styles.form } onSubmit={ event => void submit(event) }>
            <div className={ styles.heading }>
                <Text variant="heading-3">New task</Text>
                { parent && <Text color="secondary" truncate>{ `Sub-task of ${ parent.key } ${ parent.title }` }</Text> }
            </div>

            <FormField layout="vertical">
                <FormField.Label>Title</FormField.Label>
                <Input type="text" aria-label="Title" value={ title } onChange={ setTitle } placeholder="What needs doing?" autoFocus />
            </FormField>

            {/* Not a FormField: the Textarea would pass the field's `isDisabled` and `isInvalid` on to the DOM and React would warn. */}
            <div className={ styles.field }>
                <Text as="label" variant="heading-5" htmlFor={ descriptionId }>Description (optional)</Text>
                <Textarea id={ descriptionId } value={ description } onChange={ setDescription } rows={ 3 } autoResize isResizable={ false } />
            </div>

            <FormField layout="vertical">
                <FormField.Label>Status</FormField.Label>
                <Select
                    aria-label="Status"
                    items={ project.statuses }
                    selectedKey={ statusId }
                    onSelectionChange={ (key: unknown) => typeof key === 'string' && setStatusId(key) }
                >
                    { item => <ListBoxItem id={ item.id } text={ item.name } icon={ <StatusIcon category={ item.category } /> } /> }
                </Select>
            </FormField>

            <FormField layout="vertical">
                <FormField.Label>Parent</FormField.Label>
                <Select
                    aria-label="Parent"
                    icon={ parentStatus && <StatusIcon category={ parentStatus.category } /> }
                    showSearch
                    searchPlaceholder="Find a task…"
                    items={ parentOptions(parentCandidates(project.taskList), project.statuses) }
                    selectedKey={ chosenParentId ?? NO_PARENT }
                    onSelectionChange={ (key: unknown) => typeof key === 'string' && setChosenParentId(key === NO_PARENT ? null : key) }
                >
                    { option => <ListBoxItem id={ option.id } text={ option.label } icon={ option.icon } /> }
                </Select>
            </FormField>

            <FormField layout="vertical">
                <FormField.Label>Depends on</FormField.Label>
                <DependencyList
                    ids={ dependsOn }
                    tasks={ project.tasks }
                    statuses={ project.statuses }
                    candidates={ dependencyCandidates(project.taskList, { taken: dependsOn }) }
                    onAdd={ id => setDependsOn(ids => [...ids, id]) }
                    onRemove={ id => setDependsOn(ids => ids.filter(candidate => candidate !== id)) }
                />
            </FormField>

            { error && <Text color="danger" role="alert">{ error }</Text> }

            {/* No Cancel: the window's close button, Escape and a click outside already close it. */}
            <Button type="submit" color="primary" fullWidth isDisabled={ !canSubmit } isPending={ isPending }>Create task</Button>
        </form>
    );
}
