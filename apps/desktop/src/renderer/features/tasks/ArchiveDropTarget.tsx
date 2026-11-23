import { Archive } from '@clowdy/icons/14';
import { type DragEvent, useState } from 'react';

import styles from './ArchiveDropTarget.module.css';
import { DRAG_TYPE } from './taskDrag';

import type { TaskId } from '@clowdy/protocol';

export interface ArchiveDropTargetProps {
    /** A card was dropped on the target. */
    onDropTask: (taskId: TaskId) => void;
}

/**
 * A quiet strip along the bottom edge of the board, drawn only while a card is being dragged: dropping the card on it archives its task. It floats over the board's edge
 * and takes no room, so nothing moves when it appears, and the columns keep what a drop on them does. It is a target for the pointer only: the keyboard has the key and the menu.
 */
export function ArchiveDropTarget({ onDropTask }: ArchiveDropTargetProps) {
    const [isOver, setIsOver] = useState(false);

    const accepts = (event: DragEvent) => event.dataTransfer.types.includes(DRAG_TYPE);

    return (
        <div
            className={styles.target}
            data-archive-drop
            data-over={isOver || undefined}
            onDragOver={event => {
                if (!accepts(event)) return;

                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setIsOver(true);
            }}
            onDragLeave={event => {
                if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget))
                    setIsOver(false);
            }}
            onDrop={event => {
                if (!accepts(event)) return;

                event.preventDefault();
                setIsOver(false);

                const taskId = event.dataTransfer.getData(DRAG_TYPE);

                if (taskId) onDropTask(taskId);
            }}
        >
            <Archive aria-hidden />
            Archive
        </div>
    );
}
