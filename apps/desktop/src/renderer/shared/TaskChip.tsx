import { Box } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';

import { useProjectUi } from '../stores';
import styles from './Chip.module.css';

import type { Task } from '@clowdy/protocol';

export interface TaskChipProps {
    task: Pick<Task, 'id' | 'key' | 'title'>;
    /** What a press does. By default it opens the task in the Tasks tab of the side panel. */
    onPress?: () => void;
    className?: string;
}

/** A task as a chip: cube icon and key (`CAR-24`). */
export function TaskChip({ task, onPress, className }: TaskChipProps) {
    const ui = useProjectUi();

    return (
        <button
            type="button"
            className={ cn(styles.chip, className) }
            title={ task.title }
            onClick={ onPress ?? (() => ui.openTask(task.id)) }
        >
            <span className={ styles.icon }><Box width={ 12 } height={ 12 } /></span>
            <span className={ styles.label }>{ task.key }</span>
        </button>
    );
}
