import { type DragEvent, useState } from 'react';

import { ArchiveDropTarget } from './ArchiveDropTarget';
import styles from './Board.module.css';
import { StatusPill } from './status';
import { TaskCard } from './TaskCard';
import { DRAG_TYPE, useEndStuckDrag } from './taskDrag';
import { activeExecutors } from './taskView';

import type { Run, Task, TaskId, TaskStatus } from '@clowdy/protocol';
import type { TaskNotes } from './scopeView';

export interface BoardColumn {
    status: TaskStatus;
    tasks: Task[];
}

export interface BoardProps {
    columns: BoardColumn[];
    runsOfTask: ReadonlyMap<TaskId, readonly Run[]>;
    /** What a card says besides its name: the work inside the task, its checklist, the task it is inside. */
    notesOf: (task: Task) => TaskNotes;
    /** A press on a card's roll-up chip: show the insides of that task. */
    onOpenScope: (taskId: TaskId) => void;
    /** The task the detail panel shows. */
    openId: TaskId | null;
    /** The tasks the keyboard selected, for a bulk action. */
    selectedIds: ReadonlySet<TaskId>;
    /** A card was dropped on a column. Called also when the card is already there. */
    onMove: (taskId: TaskId, statusId: string) => void;
    /** A card was dropped on the Archive target, which is there only while a card is dragged. */
    onArchive: (taskId: TaskId) => void;
}

/**
 * The board: a column per status, cards in them: the tasks of one level, or every task of the scope when the sub-tasks are shown. A card dropped on another column
 * changes the task's status, in both. While a card is dragged an Archive strip floats along the bottom edge, and a card dropped on it is archived.
 * The screen handles clicks and keys.
 */
export function Board({
    columns,
    runsOfTask,
    notesOf,
    onOpenScope,
    openId,
    selectedIds,
    onMove,
    onArchive,
}: BoardProps) {
    const [dragging, setDragging] = useState<TaskId | null>(null);
    const [over, setOver] = useState<string | null>(null);

    const endDrag = () => {
        setDragging(null);
        setOver(null);
    };

    // A card rebuilt mid-drag never sends its `dragend`, and the Archive strip would stay up.
    useEndStuckDrag(dragging !== null, endDrag);

    const accepts = (event: DragEvent) => event.dataTransfer.types.includes(DRAG_TYPE);

    return (
        <div className={styles.root}>
            <div className={styles.board}>
                {columns.map(({ status, tasks }) => (
                    <section
                        key={status.id}
                        className={styles.column}
                        aria-label={status.name}
                        onDragOver={event => {
                            if (!accepts(event)) return;

                            event.preventDefault();
                            event.dataTransfer.dropEffect = 'move';
                            setOver(status.id);
                        }}
                        onDragLeave={event => {
                            if (
                                !(event.relatedTarget instanceof Node) ||
                                !event.currentTarget.contains(event.relatedTarget)
                            )
                                setOver(null);
                        }}
                        onDrop={event => {
                            if (!accepts(event)) return;

                            event.preventDefault();

                            const taskId = event.dataTransfer.getData(DRAG_TYPE);

                            endDrag();

                            if (taskId) onMove(taskId, status.id);
                        }}
                    >
                        <div className={styles.head}>
                            <StatusPill status={status} count={tasks.length} />
                        </div>
                        <div
                            className={styles.cards}
                            data-drop={(over === status.id && dragging !== null) || undefined}
                        >
                            {tasks.map(task => (
                                <TaskCard
                                    key={task.id}
                                    task={task}
                                    executors={activeExecutors(runsOfTask.get(task.id))}
                                    notes={notesOf(task)}
                                    onOpenScope={() => onOpenScope(task.id)}
                                    isSelected={selectedIds.has(task.id)}
                                    isOpen={task.id === openId}
                                    isDragging={task.id === dragging}
                                    onDragStart={event => {
                                        event.dataTransfer.setData(DRAG_TYPE, task.id);
                                        event.dataTransfer.effectAllowed = 'move';
                                        setDragging(task.id);
                                    }}
                                    onDragEnd={endDrag}
                                />
                            ))}
                            {tasks.length === 0 && <div className={styles.empty}>No tasks</div>}
                        </div>
                    </section>
                ))}
            </div>

            {dragging !== null && (
                <ArchiveDropTarget
                    onDropTask={taskId => {
                        endDrag();
                        onArchive(taskId);
                    }}
                />
            )}
        </div>
    );
}
