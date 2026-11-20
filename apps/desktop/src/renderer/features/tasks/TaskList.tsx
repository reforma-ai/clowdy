import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clowdy/components/Table';

import { AgentChip } from '../../shared';
import { StatusPill } from './status';
import styles from './TaskList.module.css';
import { activeExecutors } from './taskView';

import type { Run, Task, TaskId, TaskStatus } from '@clowdy/protocol';
import type { SyntheticEvent } from 'react';

/** A press on an agent chip belongs to the chip: left to bubble, it would also select the row and undo the chip's jump. */
const stop = (event: SyntheticEvent) => event.stopPropagation();

export interface TaskListProps {
    tasks: Task[];
    statuses: readonly TaskStatus[];
    runsOfTask: ReadonlyMap<TaskId, readonly Run[]>;
    /** The task the detail panel shows. */
    openId: TaskId | null;
    /** The tasks the keyboard selected, for a bulk action. */
    selectedIds: ReadonlySet<TaskId>;
}

/**
 * The same tasks as the board, one row each: key, title, status, and the agents working on it.
 * The table only shows the selection: `selectedKeys` mirrors the cursor's, and its own selection changes are ignored,
 * because the screen decides what a click, `X` or Shift+arrow selects. Arrow keys and `J`/`K` are the screen's too; the keys
 * it does not take (type-ahead, Space, `Tab`) are still the table's.
 */
export function TaskList({ tasks, statuses, runsOfTask, openId, selectedIds }: TaskListProps) {
    return (
        <div className={ styles.list }>
            <Table
                aria-label="Tasks"
                className={ styles.table }
                maxHeight="100%"
                selectionMode="multiple"
                selectedKeys={ selectedIds }
            >
                <TableHeader>
                    <TableHead id="key" isRowHeader className={ styles.keyColumn }>Key</TableHead>
                    <TableHead id="title">Title</TableHead>
                    <TableHead id="status" className={ styles.statusColumn }>Status</TableHead>
                    <TableHead id="agents" className={ styles.agentsColumn }>Agents</TableHead>
                </TableHeader>
                {/* The table caches a row until its task changes, so what the row shows besides the task is a dependency. */}
                <TableBody items={ tasks } dependencies={ [openId] }>
                    { task => (
                        <TableRow
                            id={ task.id }
                            className={ styles.row }
                            data-task-id={ task.id }
                            data-open={ task.id === openId || undefined }
                        >
                            <TableCell className={ styles.key }>{ task.key }</TableCell>
                            <TableCell className={ styles.title }>{ task.title }</TableCell>
                            <TableCell><StatusPill status={ statuses.find(status => status.id === task.statusId) } /></TableCell>
                            <TableCell>
                                <div className={ styles.agents } data-task-control onPointerDown={ stop } onClick={ stop } onKeyDown={ stop }>
                                    { activeExecutors(runsOfTask.get(task.id)).map(run => <AgentChip key={ run.id } run={ run } />) }
                                </div>
                            </TableCell>
                        </TableRow>
                    ) }
                </TableBody>
            </Table>
        </div>
    );
}
