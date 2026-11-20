import { useState, type DragEvent } from 'react';

import styles from './Board.module.css';
import { StatusPill } from './status';
import { TaskCard } from './TaskCard';
import { activeExecutors } from './taskView';

import type { Run, Task, TaskId, TaskStatus } from '@clowdy/protocol';

const DRAG_TYPE = 'application/x-clowdy-task';

export interface BoardColumn {
    status: TaskStatus;
    tasks: Task[];
}

export interface BoardProps {
    columns: BoardColumn[];
    runsOfTask: ReadonlyMap<TaskId, readonly Run[]>;
    /** The task the detail panel shows. */
    openId: TaskId | null;
    /** The tasks the keyboard selected, for a bulk action. */
    selectedIds: ReadonlySet<TaskId>;
    /** A card was dropped on a column. Called also when the card is already there. */
    onMove: (taskId: TaskId, statusId: string) => void;
}

/** The board: a column per status, cards in them. A card dropped on another column changes the task's status. The screen handles clicks and keys. */
export function Board({ columns, runsOfTask, openId, selectedIds, onMove }: BoardProps) {
    const [dragging, setDragging] = useState<TaskId | null>(null);
    const [over, setOver] = useState<string | null>(null);

    const endDrag = () => {
        setDragging(null);
        setOver(null);
    };

    const accepts = (event: DragEvent) => event.dataTransfer.types.includes(DRAG_TYPE);

    return (
        <div className={ styles.board }>
            { columns.map(({ status, tasks }) => (
                <section
                    key={ status.id }
                    className={ styles.column }
                    aria-label={ status.name }
                    onDragOver={ (event) => {
                        if (!accepts(event)) return;

                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'move';
                        setOver(status.id);
                    } }
                    onDragLeave={ (event) => {
                        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setOver(null);
                    } }
                    onDrop={ (event) => {
                        if (!accepts(event)) return;

                        event.preventDefault();

                        const taskId = event.dataTransfer.getData(DRAG_TYPE);

                        endDrag();

                        if (taskId) onMove(taskId, status.id);
                    } }
                >
                    <div className={ styles.head }>
                        <StatusPill status={ status } count={ tasks.length } />
                    </div>
                    <div className={ styles.cards } data-drop={ (over === status.id && dragging !== null) || undefined }>
                        { tasks.map(task => (
                            <TaskCard
                                key={ task.id }
                                task={ task }
                                executors={ activeExecutors(runsOfTask.get(task.id)) }
                                isSelected={ selectedIds.has(task.id) }
                                isOpen={ task.id === openId }
                                isDragging={ task.id === dragging }
                                onDragStart={ (event) => {
                                    event.dataTransfer.setData(DRAG_TYPE, task.id);
                                    event.dataTransfer.effectAllowed = 'move';
                                    setDragging(task.id);
                                } }
                                onDragEnd={ endDrag }
                            />
                        )) }
                        { tasks.length === 0 && <div className={ styles.empty }>No tasks</div> }
                    </div>
                </section>
            )) }
        </div>
    );
}
