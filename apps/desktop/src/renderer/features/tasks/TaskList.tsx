import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clowdy/components/Table';

import { AgentChip } from '../../shared';
import { StatusPill } from './status';
import styles from './TaskList.module.css';
import { activeExecutors, type TaskRun } from './taskView';

import type { Task, TaskId, TaskStatus } from '@clowdy/protocol';
import type { SyntheticEvent } from 'react';

/** A press on an agent chip belongs to the chip: left to bubble, it would also select the row and undo the chip's jump. */
const stop = (event: SyntheticEvent) => event.stopPropagation();

export interface TaskListProps {
    tasks: Task[];
    statuses: readonly TaskStatus[];
    runsOfTask: ReadonlyMap<TaskId, readonly TaskRun[]>;
    selectedId: TaskId | null;
    onSelect: (taskId: TaskId) => void;
}

/** The same tasks as the board, one row each: key, title, status, and the agents working on it. */
export function TaskList({ tasks, statuses, runsOfTask, selectedId, onSelect }: TaskListProps) {
    return (
        <div className={ styles.list }>
            <Table
                aria-label="Tasks"
                className={ styles.table }
                maxHeight="100%"
                selectionMode="single"
                disallowEmptySelection
                selectedKeys={ selectedId ? [selectedId] : [] }
                onSelectionChange={ (keys) => {
                    const [taskId] = keys === 'all' ? [] : [...keys];

                    if (taskId !== undefined) onSelect(String(taskId));
                } }
            >
                <TableHeader>
                    <TableHead id="key" isRowHeader className={ styles.keyColumn }>Key</TableHead>
                    <TableHead id="title">Title</TableHead>
                    <TableHead id="status" className={ styles.statusColumn }>Status</TableHead>
                    <TableHead id="agents" className={ styles.agentsColumn }>Agents</TableHead>
                </TableHeader>
                <TableBody items={ tasks }>
                    { task => (
                        <TableRow id={ task.id }>
                            <TableCell className={ styles.key }>{ task.key }</TableCell>
                            <TableCell className={ styles.title }>{ task.title }</TableCell>
                            <TableCell><StatusPill status={ statuses.find(status => status.id === task.statusId) } /></TableCell>
                            <TableCell>
                                <div className={ styles.agents } onPointerDown={ stop } onClick={ stop } onKeyDown={ stop }>
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
