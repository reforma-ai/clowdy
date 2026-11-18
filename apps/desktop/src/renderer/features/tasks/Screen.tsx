import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useCommands, useHotkeyScope } from '../../hotkeys';
import { ListCursor } from '../../hotkeys/listCursor';
import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { Board } from './Board';
import { sendCommand } from './commands';
import { openCreateTask } from './CreateTaskDialog';
import { DetailPanel } from './DetailPanel';
import styles from './Screen.module.css';
import { focusZoneOf, TASK_CONTROL, taskCommands, TASKS_SCOPE } from './taskCommands';
import { TaskList } from './TaskList';
import { TasksHeader } from './TasksHeader';
import { agentOptions, boardColumns, filterTasks, isFiltering, NO_FILTER, runsByTask, taskGrid, tasksSource } from './taskView';

import type { TaskId } from '@clowdy/protocol';
import type { FocusEvent, MouseEvent, PointerEvent } from 'react';

const taskIdOf = (target: EventTarget | null): TaskId | null => (target instanceof Element ? target.closest<HTMLElement>('[data-task-id]')?.dataset.taskId ?? null : null);

/** The agent chips on a card or row do their own thing when pressed; a press there is not a press on the task. */
const isTaskControl = (target: EventTarget | null) => target instanceof Element && target.closest(TASK_CONTROL) !== null;

/** Tasks: the project's internal task list as a board or a table, with a detail panel for the open task. */
export function Screen() {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const [filter, setFilter] = useState(NO_FILTER);
    const [cursor] = useState(() => new ListCursor());
    const region = useRef<HTMLDivElement>(null);

    const runsOfTask = runsByTask(project.runTaskLinks.values(), project.runs);
    const tasks = project.taskList;
    const visible = filterTasks(tasks, filter, runsOfTask);
    const columns = boardColumns(project.statuses, visible);

    const selected = ui.taskId ? project.tasks.get(ui.taskId) : undefined;

    const move = (taskId: string, statusId: string) => {
        if (project.tasks.get(taskId)?.statusId !== statusId) void sendCommand(root, { type: 'task.update', taskId, statusId });
    };

    // The cursor walks what the view draws. It follows the open task when that changes from elsewhere (a dependency link, a chip in Chats).
    useLayoutEffect(() => cursor.setGrid(taskGrid(ui.tasksView, visible, project.statuses), ui.taskId));

    useEffect(() => {
        if (ui.taskId !== null) cursor.setCursor(ui.taskId);
    }, [cursor, ui.taskId]);

    const itemOf = (taskId: TaskId) => region.current?.querySelector<HTMLElement>(`[data-task-id="${ CSS.escape(taskId) }"]`) ?? null;

    /** The card's title button or the row itself holds the DOM focus, so a screen reader and the keys that are not ours follow the cursor. */
    const focusItem = (taskId: TaskId, { scroll }: { scroll: boolean }) => {
        const item = itemOf(taskId);
        const focusable = item?.hasAttribute('tabindex') ? item : item?.querySelector<HTMLElement>('button');

        focusable?.focus({ preventScroll: true });

        if (scroll) item?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };

    const focusZone = () => focusZoneOf(document.activeElement, region.current);

    useHotkeyScope(TASKS_SCOPE);
    useCommands(TASKS_SCOPE, taskCommands({
        cursor,
        ui,
        hasTask: taskId => project.tasks.has(taskId),
        view: () => ui.tasksView,
        focusZone,
        isCursorFocused: () => cursor.cursorId !== null && taskIdOf(document.activeElement) === cursor.cursorId,
        revealCursor: () => {
            if (cursor.cursorId !== null) focusItem(cursor.cursorId, { scroll: true });
        },
    }));

    // A click opens the task, Cmd/Ctrl toggles it in the selection, Shift selects the range from the anchor. One place for board and list.
    const onClickCapture = (event: MouseEvent) => {
        const taskId = taskIdOf(event.target);

        if (taskId === null || isTaskControl(event.target)) return;

        if (event.shiftKey) {
            cursor.extendTo(taskId);
        }
        else if (event.metaKey || event.ctrlKey) {
            cursor.toggle(taskId);
        }
        else {
            cursor.anchorAt(taskId);
            ui.openTask(taskId);
        }
    };

    // Only real movement moves the cursor: a resting pointer under a list that scrolls to the keyboard cursor must not take it back.
    const onPointerMove = (event: PointerEvent) => {
        const taskId = taskIdOf(event.target);

        if ((event.movementX === 0 && event.movementY === 0) || taskId === null || taskId === cursor.cursorId) return;

        cursor.setCursor(taskId);

        // Focus follows the cursor only where it is free to: never out of a search field or the panel.
        if (focusZone() === 'list') focusItem(taskId, { scroll: false });
    };

    // Focus that arrives by Tab, a click or the table's type-ahead puts the cursor there too.
    const onFocus = (event: FocusEvent) => {
        const taskId = taskIdOf(event.target);

        if (taskId !== null) cursor.setCursor(taskId);
    };

    return (
        <div className={ styles.screen }>
            <div className={ styles.main }>
                <TasksHeader
                    subtitle={ tasksSource(tasks) }
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
                    : (
                        <div ref={ region } className={ styles.region } onClickCapture={ onClickCapture } onPointerMove={ onPointerMove } onFocus={ onFocus }>
                            { ui.tasksView === 'board'
                                ? <Board columns={ columns } runsOfTask={ runsOfTask } openId={ selected?.id ?? null } selectedIds={ cursor.selected } onMove={ move } />
                                : <TaskList tasks={ visible } statuses={ project.statuses } runsOfTask={ runsOfTask } openId={ selected?.id ?? null } selectedIds={ cursor.selected } />
                            }
                        </div>
                    )
                }
            </div>

            { selected && <DetailPanel key={ selected.id } task={ selected } taskRuns={ runsOfTask.get(selected.id) ?? [] } /> }
        </div>
    );
}
