import { Button } from '@clowdy/components/Button';
import { openConfirmModal } from '@clowdy/components/modals';
import { Text } from '@clowdy/components/Text';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useCommands, useHotkeyScope } from '../../hotkeys';
import { ListCursor } from '../../hotkeys/listCursor';
import { PickerPopover, type PickerRequest } from '../../shared/PickerPopover';
import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { Board } from './Board';
import { sendCommand, sendEach, startTask } from './commands';
import { openCreateTask } from './CreateTaskDialog';
import { DetailPanel } from './DetailPanel';
import styles from './Screen.module.css';
import { focusZoneOf, TASK_CONTROL, taskCommands, TASKS_SCOPE } from './taskCommands';
import { TaskList } from './TaskList';
import { TasksHeader } from './TasksHeader';
import { agentOptions, boardColumns, filterTasks, isFiltering, NO_FILTER, runsByTask, startBlockedReason, taskGrid, tasksSource } from './taskView';

import type { TaskId } from '@clowdy/protocol';
import type { FocusEvent, MouseEvent, PointerEvent } from 'react';

/** The card or row the target is in or is. */
const itemAt = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>('[data-task-id]') : null);

const taskIdOf = (target: EventTarget | null): TaskId | null => itemAt(target)?.dataset.taskId ?? null;

/** The agent chips on a card or row do their own thing when pressed; a press there is not a press on the task. */
const isTaskControl = (target: EventTarget | null) => target instanceof Element && target.closest(TASK_CONTROL) !== null;

const itemOf = (region: Element | null, taskId: TaskId) => region?.querySelector<HTMLElement>(`[data-task-id="${ CSS.escape(taskId) }"]`) ?? null;

/** The card's title button or the row itself holds the DOM focus, so a screen reader and the keys that are not ours follow the cursor. */
function focusItem(region: Element | null, taskId: TaskId, { scroll }: { scroll: boolean }) {
    const item = itemOf(region, taskId);
    const focusable = item?.hasAttribute('tabindex') ? item : item?.querySelector<HTMLElement>('button');

    focusable?.focus({ preventScroll: true });

    if (scroll) item?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** Nothing has focus: the page does. */
const isFocusLost = () => !document.activeElement || document.activeElement === document.body;

/** A picker that is open, and the element it opened beside. */
interface OpenPicker {
    request: PickerRequest;
    anchor: Element | null;
}

/** Tasks: the project's internal task list as a board or a table, with a detail panel for the open task. */
export function Screen() {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const [filter, setFilter] = useState(NO_FILTER);
    const [cursor] = useState(() => new ListCursor());
    const [picker, setPicker] = useState<OpenPicker | null>(null);
    const screen = useRef<HTMLDivElement>(null);
    const region = useRef<HTMLDivElement>(null);
    const titleField = useRef<HTMLTextAreaElement>(null);
    // The card or row that last had focus, to notice when it has left the page.
    const focusedItem = useRef<Element | null>(null);

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

    const reveal = (taskId: TaskId, options: { scroll: boolean }) => focusItem(region.current, taskId, options);

    const focusZone = () => focusZoneOf(document.activeElement, region.current);

    const revealCursor = () => {
        if (cursor.cursorId !== null) reveal(cursor.cursorId, { scroll: true });
    };

    /**
     * The card or row that had focus is gone (a card rebuilt in another column when its status changes, the row of a deleted task) and focus fell to the page.
     * The cursor follows the task, or its neighbour when the task is gone, so it is where focus goes next.
     */
    const refocusIfRemoved = () => {
        const item = focusedItem.current;

        if (!item || item.isConnected || !isFocusLost()) return;

        focusedItem.current = null;
        revealCursor();
    };

    // After the cursor has its new grid and the board its new cards.
    useLayoutEffect(refocusIfRemoved);

    useHotkeyScope(TASKS_SCOPE);
    useCommands(TASKS_SCOPE, taskCommands({
        cursor,
        ui,
        hasTask: taskId => project.tasks.has(taskId),
        view: () => ui.tasksView,
        focusZone,
        isCursorFocused: () => cursor.cursorId !== null && taskIdOf(document.activeElement) === cursor.cursorId,
        revealCursor,
        // Read from the stores when asked, so a key hint that asks whether Start is available follows the runs.
        tasks: () => project.taskList,
        statuses: () => project.statuses,
        startBlocked: taskId => startBlockedReason(runsByTask(project.runTaskLinks.values(), project.runs).get(taskId)),
        send: inputs => sendEach(root, inputs),
        start: taskId => startTask(root, taskId),
        openPicker: request => setPicker({ request, anchor: (cursor.cursorId === null ? null : itemOf(region.current, cursor.cursorId)) ?? screen.current?.querySelector('aside') ?? null }),
        // The dialog hands focus back to what had it, which is gone when the daemon's event came in while it was open. That happens after `onClose`.
        confirm: options => openConfirmModal(options, { onClose: () => setTimeout(refocusIfRemoved) }),
        focusTitle: () => {
            // The panel for the task is drawn by the time of the next frame.
            requestAnimationFrame(() => {
                titleField.current?.focus({ preventScroll: true });
                titleField.current?.select();
            });
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
        if (focusZone() === 'list') reveal(taskId, { scroll: false });
    };

    // Focus that arrives by Tab, a click or the table's type-ahead puts the cursor there too.
    const onFocus = (event: FocusEvent) => {
        const item = itemAt(event.target);

        if (!item?.dataset.taskId) return;

        focusedItem.current = item;
        cursor.setCursor(item.dataset.taskId);
    };

    return (
        <div ref={ screen } className={ styles.screen }>
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

            { selected && <DetailPanel key={ selected.id } task={ selected } taskRuns={ runsOfTask.get(selected.id) ?? [] } titleRef={ titleField } /> }

            { picker && <PickerPopover anchor={ picker.anchor } { ...picker.request } onClose={ () => setPicker(null) } /> }
        </div>
    );
}
