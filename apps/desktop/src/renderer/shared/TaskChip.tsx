import { Tooltip } from '@clowdy/components/Tooltip';
import { cn } from '@clowdy/lib';

import { StatusIcon, statusTone } from '../features/tasks/status';
import { useProjectState, useProjectUi } from '../stores';
import styles from './Chip.module.css';
import toneStyles from './StatusTone.module.css';

import type { Task, TaskStatus } from '@clowdy/protocol';

export interface TaskChipProps {
    task: Pick<Task, 'id' | 'key' | 'title'> & Partial<Pick<Task, 'statusId'>>;
    /** What a press does. By default it opens the task in the Tasks tab of the side panel. */
    onPress?: () => void;
    className?: string;
}

export const taskChipClass = cn(styles.chip, toneStyles.tone);

export function TaskChipContents({ label, status }: { label: string; status?: TaskStatus }) {
    return (
        <>
            {status && <StatusIcon category={status.category} size={12} />}
            <span className={styles.label}>{label}</span>
        </>
    );
}

/** A task key with the current status's icon and tone, opening the task when pressed. */
export function TaskChipButton({ task, onPress, className }: TaskChipProps) {
    const project = useProjectState();
    const statusId = project.taskById(task.id)?.statusId ?? task.statusId;
    const status = project.statuses.find(candidate => candidate.id === statusId);

    return (
        <Tooltip content={task.title}>
            <button
                type="button"
                className={cn(taskChipClass, className)}
                data-tone={statusTone(status?.category)}
                aria-description={status?.name}
                onClick={onPress}
            >
                <TaskChipContents label={task.key} status={status} />
            </button>
        </Tooltip>
    );
}

export function TaskChip({ task, onPress, className }: TaskChipProps) {
    const ui = useProjectUi();

    return <TaskChipButton task={task} className={className} onPress={onPress ?? (() => ui.openTask(task.id))} />;
}
