import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { useState } from 'react';

import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { Board } from './Board';
import { sendCommand } from './commands';
import { openCreateTask } from './CreateTaskDialog';
import { DetailPanel } from './DetailPanel';
import styles from './Screen.module.css';
import { TaskList } from './TaskList';
import { TasksHeader } from './TasksHeader';
import { agentOptions, filterTasks, groupByStatus, isFiltering, NO_FILTER, runsByTask, tasksSource } from './taskView';

/** Tasks: the project's internal task list as a board or a table, with a detail panel for the selected task. */
export function Screen() {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const [filter, setFilter] = useState(NO_FILTER);

    const runsOfTask = runsByTask(project.runTaskLinks.values(), project.runs);
    const tasks = project.taskList;
    const visible = filterTasks(tasks, filter, runsOfTask);
    const byStatus = groupByStatus(visible);
    const columns = project.statuses.map(status => ({ status, tasks: byStatus.get(status.id) ?? [] }));

    const selected = ui.taskId ? project.tasks.get(ui.taskId) : undefined;

    const move = (taskId: string, statusId: string) => {
        if (project.tasks.get(taskId)?.statusId !== statusId) void sendCommand(root, { type: 'task.update', taskId, statusId });
    };

    return (
        <div className={ styles.screen }>
            <div className={ styles.main }>
                <TasksHeader
                    subtitle={ `${ tasksSource(tasks) } · ${ project.project.name }` }
                    view={ ui.tasksView }
                    onViewChange={ view => ui.setTasksView(view) }
                    onCreate={ () => openCreateTask({ root, project, ui }) }
                    filter={ filter }
                    onFilterChange={ setFilter }
                    statuses={ project.statuses }
                    agents={ agentOptions(runsOfTask) }
                />

                { visible.length === 0
                    ? (
                        <div className={ styles.message }>
                            <Text variant="heading-4">{ tasks.length === 0 ? 'No tasks yet' : 'No tasks match' }</Text>
                            <Text color="secondary">
                                { tasks.length === 0 ? 'Create one, or ask the orchestrator in a chat to plan the work.' : 'Try a different search or clear the filters.' }
                            </Text>
                            { tasks.length > 0 && isFiltering(filter) && <Button variant="bordered" size="sm" onPress={ () => setFilter(NO_FILTER) }>Clear filters</Button> }
                        </div>
                    )
                    : ui.tasksView === 'board'
                        ? <Board columns={ columns } runsOfTask={ runsOfTask } selectedId={ selected?.id ?? null } onSelect={ id => ui.openTask(id) } onMove={ move } />
                        : <TaskList tasks={ visible } statuses={ project.statuses } runsOfTask={ runsOfTask } selectedId={ selected?.id ?? null } onSelect={ id => ui.openTask(id) } />
                }
            </div>

            { selected && <DetailPanel key={ selected.id } task={ selected } taskRuns={ runsOfTask.get(selected.id) ?? [] } /> }
        </div>
    );
}
