import { Chip } from '@clowdy/components/Chip';

import { StatusIcon, statusTone } from '../features/tasks/status';
import { useProjectState, useProjectUi } from '../stores';

import type { Task, TaskStatus } from '@clowdy/protocol';

export interface TaskChipProps {
    task: Pick<Task, 'id' | 'key' | 'title'> & Partial<Pick<Task, 'statusId'>>;
    /** What a press does. By default it opens the task in the Tasks tab of the side panel. */
    onPress?: () => void;
    className?: string;
}

/** The icon of a task chip: the status's own icon in its tone, or nothing for a status the workflow no longer has. */
export function taskChipIcon(status: TaskStatus | undefined) {
    return status && <StatusIcon category={status.category} size={12} />;
}

/** A task key with the current status's icon and tone, opening the task when pressed. Its name carries the status, which the icon shows. */
export function TaskChipButton({ task, onPress, className }: TaskChipProps) {
    const project = useProjectState();
    const statusId = project.taskById(task.id)?.statusId ?? task.statusId;
    const status = project.statuses.find(candidate => candidate.id === statusId);

    return (
        <Chip
            className={className}
            tone={statusTone(status?.category)}
            icon={taskChipIcon(status)}
            tooltip={task.title}
            aria-label={status ? `${task.key}, ${status.name}` : undefined}
            onPress={onPress}
        >
            {task.key}
        </Chip>
    );
}

export function TaskChip({ task, onPress, className }: TaskChipProps) {
    const ui = useProjectUi();

    return <TaskChipButton task={task} className={className} onPress={onPress ?? (() => ui.openTask(task.id))} />;
}
