import { Box } from '@clowdy/icons/14';

import { AgentChip } from '../../shared';
import styles from './TaskCard.module.css';

import type { Run, Task } from '@clowdy/protocol';
import type { DragEvent } from 'react';

export interface TaskCardProps {
    task: Task;
    /** The runs executing the task now. */
    executors: Run[];
    isSelected: boolean;
    isDragging: boolean;
    onSelect: () => void;
    onDragStart: (event: DragEvent<HTMLElement>) => void;
    onDragEnd: () => void;
}

/** A task on the board: key, title, and a chip for each agent working on it. Drag it to another column to change its status. */
export function TaskCard({ task, executors, isSelected, isDragging, onSelect, onDragStart, onDragEnd }: TaskCardProps) {
    return (
        <article
            className={ styles.card }
            data-selected={ isSelected || undefined }
            data-dragging={ isDragging || undefined }
            draggable
            onDragStart={ onDragStart }
            onDragEnd={ onDragEnd }
        >
            <span className={ styles.key }>
                <Box aria-hidden width={ 12 } height={ 12 } />
                { task.key }
            </span>
            <button type="button" className={ styles.title } aria-pressed={ isSelected } onClick={ onSelect }>{ task.title }</button>
            { executors.length > 0 && (
                <div className={ styles.agents }>
                    { executors.map(run => <AgentChip key={ run.id } run={ run } />) }
                </div>
            ) }
        </article>
    );
}
