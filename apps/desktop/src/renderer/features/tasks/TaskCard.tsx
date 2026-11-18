import { Box } from '@clowdy/icons/14';

import { AgentChip } from '../../shared';
import styles from './TaskCard.module.css';

import type { Run, Task } from '@clowdy/protocol';
import type { DragEvent } from 'react';

export interface TaskCardProps {
    task: Task;
    /** The runs executing the task now. */
    executors: Run[];
    /** The task is in the selection (`X`, Shift+arrows, Cmd/Ctrl-click). */
    isSelected: boolean;
    /** The detail panel shows this task. */
    isOpen: boolean;
    isDragging: boolean;
    onDragStart: (event: DragEvent<HTMLElement>) => void;
    onDragEnd: () => void;
}

/**
 * A task on the board: key, title, and a chip for each agent working on it. Drag it to another column to change its status.
 * Clicks and keys are read by the screen from `data-task-id`, not here, so a card has no handler of its own.
 */
export function TaskCard({ task, executors, isSelected, isOpen, isDragging, onDragStart, onDragEnd }: TaskCardProps) {
    return (
        <article
            className={ styles.card }
            data-task-id={ task.id }
            data-selected={ isSelected || undefined }
            data-open={ isOpen || undefined }
            data-dragging={ isDragging || undefined }
            draggable
            onDragStart={ onDragStart }
            onDragEnd={ onDragEnd }
        >
            <span className={ styles.key }>
                <Box aria-hidden width={ 12 } height={ 12 } />
                { task.key }
            </span>
            <button type="button" className={ styles.title } aria-pressed={ isSelected } aria-current={ isOpen || undefined }>{ task.title }</button>
            { executors.length > 0 && (
                <div className={ styles.agents } data-task-control>
                    { executors.map(run => <AgentChip key={ run.id } run={ run } />) }
                </div>
            ) }
        </article>
    );
}
