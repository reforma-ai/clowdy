import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clowdy/components/Table';
import { ChevronDown, ChevronRight } from '@clowdy/icons/8';

import { AgentChip } from '../../shared';
import { StatusPill } from './status';
import { ChecklistChip, RollUpChip } from './TaskChips';
import styles from './TaskList.module.css';
import { activeExecutors } from './taskView';

import type { Run, Task, TaskId, TaskStatus } from '@clowdy/protocol';
import type { CSSProperties, SyntheticEvent } from 'react';
import type { TaskNotes } from './scopeView';
import type { TreeRow } from './taskTree';

/** A press on a control of the row (an agent chip, a fold, a roll-up chip) belongs to the control: left to bubble, it would also select the row and undo what the control did. */
const stop = (event: SyntheticEvent) => event.stopPropagation();

export interface TaskListProps {
    /** The rows of the tree, in the order they are drawn, with the folded ones' insides left out. */
    rows: readonly TreeRow[];
    statuses: readonly TaskStatus[];
    runsOfTask: ReadonlyMap<TaskId, readonly Run[]>;
    /** What a row says besides its name: the work inside the task and its checklist. */
    notesOf: (task: Task) => TaskNotes;
    /** A press on a row's roll-up chip: show the insides of that task. */
    onOpenScope: (taskId: TaskId) => void;
    /** A press on a row's chevron: fold the insides of the task, or open them. */
    onToggle: (taskId: TaskId) => void;
    /** The task the detail panel shows. */
    openId: TaskId | null;
    /** The tasks the keyboard selected, for a bulk action. */
    selectedIds: ReadonlySet<TaskId>;
}

/**
 * The tasks of the scope as a tree, one row each: the task under its parent, indented, with a chevron to fold what is inside it, then key, title, status,
 * and the agents working on it. Tasks of one parent run by workflow status and then number.
 * The table only shows the selection: `selectedKeys` mirrors the cursor's, and its own selection changes are ignored,
 * because the screen decides what a click, `X` or Shift+arrow selects. Arrow keys and `J`/`K` are the screen's too; the keys
 * it does not take (type-ahead, Space, `Tab`) are still the table's.
 */
export function TaskList({
    rows,
    statuses,
    runsOfTask,
    notesOf,
    onOpenScope,
    onToggle,
    openId,
    selectedIds,
}: TaskListProps) {
    return (
        <div className={styles.list}>
            <Table
                aria-label="Tasks"
                className={styles.table}
                maxHeight="100%"
                selectionMode="multiple"
                selectedKeys={selectedIds}
            >
                <TableHeader>
                    <TableHead id="key" isRowHeader className={styles.keyColumn}>
                        Key
                    </TableHead>
                    <TableHead id="title">Title</TableHead>
                    <TableHead id="status" className={styles.statusColumn}>
                        Status
                    </TableHead>
                    <TableHead id="agents" className={styles.agentsColumn}>
                        Agents
                    </TableHead>
                </TableHeader>
                {/* The rows are built again on every render, so the table's cache of a row (kept while its item is the same object) never serves one that is stale. */}
                <TableBody items={rows}>
                    {({ task, depth, hasChildren, collapsed }) => {
                        const { rollUp, checklist } = notesOf(task);

                        return (
                            <TableRow
                                id={task.id}
                                className={styles.row}
                                data-task-id={task.id}
                                data-open={task.id === openId || undefined}
                                data-depth={depth}
                            >
                                <TableCell className={styles.key}>{task.key}</TableCell>
                                <TableCell className={styles.title}>
                                    {/* A table row carries no level (React Aria passes no `aria-level` through), so a screen reader is told it here, as the first words of the cell. */}
                                    <span className={styles.level}>{`Level ${depth + 1}`}</span>
                                    <div className={styles.line} style={{ '--depth': depth } as CSSProperties}>
                                        {/* A row with nothing inside leaves the room, so the titles of one level line up, and a press there is a press on the row. The keys fold from the keyboard, so the button is for the pointer. */}
                                        <span className={styles.fold}>
                                            {hasChildren && (
                                                <button
                                                    type="button"
                                                    tabIndex={-1}
                                                    data-task-control
                                                    className={styles.chevron}
                                                    aria-expanded={!collapsed}
                                                    aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${task.key}`}
                                                    onPointerDown={stop}
                                                    onKeyDown={stop}
                                                    onClick={event => {
                                                        event.stopPropagation();
                                                        onToggle(task.id);
                                                    }}
                                                >
                                                    {collapsed ? <ChevronRight /> : <ChevronDown />}
                                                </button>
                                            )}
                                        </span>
                                        <span className={styles.text}>{task.title}</span>
                                        {(checklist || rollUp) && (
                                            <span className={styles.chips}>
                                                {checklist && <ChecklistChip checklist={checklist} />}
                                                {rollUp && (
                                                    <RollUpChip
                                                        rollUp={rollUp}
                                                        taskKey={task.key}
                                                        onPress={() => onOpenScope(task.id)}
                                                    />
                                                )}
                                            </span>
                                        )}
                                    </div>
                                </TableCell>
                                <TableCell>
                                    <StatusPill status={statuses.find(status => status.id === task.statusId)} />
                                </TableCell>
                                <TableCell>
                                    <div
                                        className={styles.agents}
                                        data-task-control
                                        onPointerDown={stop}
                                        onClick={stop}
                                        onKeyDown={stop}
                                    >
                                        {activeExecutors(runsOfTask.get(task.id)).map(run => (
                                            <AgentChip key={run.id} run={run} />
                                        ))}
                                    </div>
                                </TableCell>
                            </TableRow>
                        );
                    }}
                </TableBody>
            </Table>
        </div>
    );
}
