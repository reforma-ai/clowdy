import { Box } from '@clowdy/icons/14';

import { AgentChip } from '../../shared';
import styles from './TaskCard.module.css';
import { ChecklistChip, RollUpChip } from './TaskChips';

import type { Run, Task } from '@clowdy/protocol';
import type { DragEvent } from 'react';
import type { TaskNotes } from './scopeView';

export interface TaskCardProps {
    task: Task;
    /** The runs executing the task now. */
    executors: Run[];
    /** The work inside the task, its checklist, and the task it is inside when the board draws it away from it. */
    notes: TaskNotes;
    /** Opens the task's own scope: what a press on its roll-up chip does. */
    onOpenScope: () => void;
    /** The task is in the selection (`X`, Shift+arrows, Cmd/Ctrl-click). */
    isSelected: boolean;
    /** The detail panel shows this task. */
    isOpen: boolean;
    isDragging: boolean;
    onDragStart: (event: DragEvent<HTMLElement>) => void;
    onDragEnd: () => void;
}

/**
 * A task on the board: key (and the task it is inside, when the board shows it away from its parent), title, the chips for its checklist and the work inside it,
 * and a chip for each agent working on it. Drag it to another column to change its status.
 * Clicks and keys are read by the screen from `data-task-id`, not here, so a card has no handler of its own.
 */
export function TaskCard({ task, executors, notes, onOpenScope, isSelected, isOpen, isDragging, onDragStart, onDragEnd }: TaskCardProps) {
    const { rollUp, checklist, parentKey } = notes;

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
                { parentKey && <span className={ styles.parent } title={ `Sub-task of ${ parentKey }` }>{ `in ${ parentKey }` }</span> }
            </span>
            <button type="button" className={ styles.title } aria-pressed={ isSelected } aria-current={ isOpen || undefined }>{ task.title }</button>
            { (checklist || rollUp) && (
                <div className={ styles.chips }>
                    { checklist && <ChecklistChip checklist={ checklist } /> }
                    { rollUp && <RollUpChip rollUp={ rollUp } taskKey={ task.key } onPress={ onOpenScope } /> }
                </div>
            ) }
            { executors.length > 0 && (
                <div className={ styles.agents } data-task-control>
                    { executors.map(run => <AgentChip key={ run.id } run={ run } />) }
                </div>
            ) }
        </article>
    );
}
