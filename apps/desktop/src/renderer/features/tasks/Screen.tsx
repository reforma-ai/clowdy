import { openConfirmModal } from '@clowdy/components/modals';
import { toast } from '@clowdy/components/Toast';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useCommands, useHotkeyScope } from '../../hotkeys';
import { ListCursor } from '../../hotkeys/listCursor';
import { undoStack } from '../../hotkeys/undo';
import { PickerPopover, type PickerRequest } from '../../shared/PickerPopover';
import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { openChat } from '../chats/archiveChat';
import { Board } from './Board';
import { copyWithToast, startTask } from './commands';
import { openCreateTask } from './CreateTaskDialog';
import { DetailPanel } from './DetailPanel';
import { ScopeEmpty } from './ScopeEmpty';
import { ScopeHeader } from './ScopeHeader';
import styles from './Screen.module.css';
import { focusZoneOf, TASK_CONTROL, taskCommands, TASKS_SCOPE } from './taskCommands';
import { TaskList } from './TaskList';
import { TasksHeader } from './TasksHeader';
import { DEPTH_LIMIT_HINT } from './taskTree';
import { sendWithUndo } from './taskUndo';
import { agentOptions, isFiltering, newestDocPath, NO_FILTER, runsByTask, startBlockedReason, tasksSource } from './taskView';
import { useTasksScope } from './useTasksScope';

import type { TaskId } from '@clowdy/protocol';
import type { FocusEvent, KeyboardEvent, MouseEvent, PointerEvent } from 'react';

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

/**
 * Tasks: the project's internal task list. It shows a scope, the tasks inside a task or the project's roots, as a board of one level, a board of every level, or a
 * tree list, with a detail panel for the open task. `useTasksScope` holds what the scope and its view are; this component wires the keys, the focus and the pieces.
 */
export function Screen() {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const [filter, setFilter] = useState(NO_FILTER);
    const [cursor] = useState(() => new ListCursor());
    const [picker, setPicker] = useState<OpenPicker | null>(null);
    const [isFilterOpen, setFilterOpen] = useState(false);
    const screen = useRef<HTMLDivElement>(null);
    const region = useRef<HTMLDivElement>(null);
    const titleField = useRef<HTMLTextAreaElement>(null);
    const searchField = useRef<HTMLInputElement>(null);
    // The card or row that last had focus, to notice when it has left the page.
    const focusedItem = useRef<Element | null>(null);
    // The filter popover was opened with `F`, and the keyboard goes back to the list when it closes.
    const filterFromKey = useRef(false);
    // The title is being edited after `Shift+R`, and the key that ends the edit hands the keyboard back to the list.
    const renaming = useRef(false);

    const runsOfTask = runsByTask(project.runTaskLinks.values(), project.runs);
    const tasks = project.taskList;
    const { scope, ancestors, tree, view, content, notesOf, open, setView, commandDeps, settle, nav } = useTasksScope({ cursor, filter, runsOfTask });

    const selected = ui.taskId ? project.tasks.get(ui.taskId) : undefined;

    const move = (taskId: string, statusId: string) => {
        if (project.tasks.get(taskId)?.statusId !== statusId) void sendWithUndo(root, project, [{ type: 'task.update', taskId, statusId }]);
    };

    // The cursor follows the open task, also one that has not reached the project yet (the daemon's event can come after the dialog that made it closed).
    useEffect(() => {
        if (ui.taskId !== null) cursor.setCursor(ui.taskId);
    }, [cursor, ui.taskId, selected?.id]);

    const reveal = (taskId: TaskId, options: { scroll: boolean }) => focusItem(region.current, taskId, options);

    // A press on a chevron focuses the button, which keeps its own keys: the row takes the keyboard back, so J, K and the arrows go on working.
    const toggleFold = (taskId: TaskId) => {
        ui.toggleTaskCollapsed(taskId);
        cursor.setCursor(taskId);
        reveal(taskId, { scroll: false });
    };

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

        // The focus event of the new item records it, so the old one is dropped first.
        focusedItem.current = null;
        revealCursor();

        // The list builds its rows a render after the board's cards are gone, so the item may not be there yet: the view switch below asks again.
        if (isFocusLost()) focusedItem.current = item;
    };

    // After the cursor has its new grid and the board its new cards.
    useLayoutEffect(refocusIfRemoved);

    // The other view, or another scope, has drawn its items a frame after the switch.
    useEffect(() => {
        const frame = requestAnimationFrame(() => {
            refocusIfRemoved();

            // Still gone after a frame: the item is not coming back, and a later blur is not the view's doing.
            if (focusedItem.current?.isConnected === false) focusedItem.current = null;
        });

        return () => cancelAnimationFrame(frame);
    }, [content.mode, scope?.id]);

    /** Something that held the keyboard (a dialog, the title field, the filter popover) is gone and it fell to the page: the cursor takes it, so the next key works on the list. */
    const refocusIfLost = () => {
        if (isFocusLost()) revealCursor();
    };

    // The person acts: a scope that is gone is settled first, so Back returns to what they saw. A press passes its event to the handler, so the parent is a parameter of its own function.
    const createIn = (parentId?: TaskId) => {
        settle();
        openCreateTask({ root, project, ui, parentId }, { onClose: () => setTimeout(refocusIfLost) });
    };
    // "+ Task" and `C` make a task where the screen is: a sub-task of the task it is inside, a task of the roots at the roots.
    const createTask = () => createIn(scope?.id);
    const isFull = scope !== undefined && !tree.canHaveChildren(scope);

    // Shown after React Aria hands focus back to the Filter button, and only if it is still there: a click on another control moved it on purpose.
    const leaveFilter = () => setTimeout(() => {
        if (isFocusLost() || document.activeElement?.closest('[data-filter-trigger]')) revealCursor();
    });

    const onFilterOpenChange = (isOpen: boolean) => {
        setFilterOpen(isOpen);

        if (!isOpen && filterFromKey.current) {
            filterFromKey.current = false;
            leaveFilter();
        }
    };

    const exitSearch = () => {
        if (cursor.cursorId === null) searchField.current?.blur();
        else revealCursor();
    };

    useHotkeyScope(TASKS_SCOPE);
    useCommands(TASKS_SCOPE, taskCommands({
        cursor,
        ...commandDeps,
        ui: nav,
        hasTask: taskId => project.tasks.has(taskId),
        focusZone,
        isCursorFocused: () => cursor.cursorId !== null && taskIdOf(document.activeElement) === cursor.cursorId,
        revealCursor,
        // Read from the stores when asked, so a key hint that asks whether Start is available follows the runs.
        tasks: () => project.taskList,
        statuses: () => project.statuses,
        startBlocked: taskId => startBlockedReason(runsByTask(project.runTaskLinks.values(), project.runs).get(taskId)),
        send: inputs => sendWithUndo(root, project, inputs),
        // Only this project's changes: the stack is the window's, an entry belongs to the project it was made in.
        undo: { canUndo: () => undoStack.canUndo(project.id), undoLatest: () => undoStack.undoLatest(project.id) },
        start: taskId => startTask(root, taskId),
        openPicker: request => setPicker({ request, anchor: (cursor.cursorId === null ? null : itemOf(region.current, cursor.cursorId)) ?? screen.current?.querySelector('aside') ?? null }),
        // The dialog hands focus back to what had it, which is gone when the daemon's event came in while it was open. That happens after `onClose`.
        confirm: options => openConfirmModal(options, { onClose: () => setTimeout(refocusIfRemoved) }),
        focusTitle: () => {
            // The panel for the task is drawn by the time of the next frame.
            requestAnimationFrame(() => {
                renaming.current = titleField.current !== null;
                titleField.current?.focus({ preventScroll: true });
                titleField.current?.select();
            });
        },
        create: createTask,
        openFilter: () => {
            filterFromKey.current = true;
            setFilterOpen(true);
        },
        focusSearch: () => {
            searchField.current?.focus();
            searchField.current?.select();
        },
        openChat: (chatId) => {
            settle();
            void openChat(root, project, ui, chatId);
        },
        chatsOf: taskId => project.chatsOfTask(taskId),
        docPathOf: async taskId => newestDocPath((await root.transport.getTaskDetail(taskId)).artifacts),
        copy: copyWithToast,
        notify: (message, tone = 'info') => void (tone === 'error' ? toast.error({ message }) : toast.info({ message })),
        // The scope is settled before the overwrite, so the entry that is overwritten is the one that says what the screen shows.
        replacing: (change) => {
            settle();
            root.history.replacing(change);
        },
    }));

    // Enter saves a title and Esc drops the edit, and both leave the field. The capture runs before the field's own handler blurs it.
    const onKeyDownCapture = (event: KeyboardEvent) => {
        if (renaming.current && event.target === titleField.current && (event.key === 'Enter' || event.key === 'Escape')) setTimeout(refocusIfLost);
    };

    // The edit is over however it ended, so a later click into the title is not a rename from the keyboard.
    const onBlur = (event: FocusEvent) => {
        if (event.target === titleField.current) renaming.current = false;
    };

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
            nav.openTask(taskId);
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
        <div ref={ screen } className={ styles.screen } onKeyDownCapture={ onKeyDownCapture } onBlur={ onBlur }>
            <div className={ styles.main }>
                <TasksHeader
                    subtitle={ tasksSource(tasks) }
                    path={ scope && { ancestors, task: scope } }
                    onOpenScope={ open }
                    view={ view }
                    onViewChange={ setView }
                    showSubtasks={ ui.tasksSubtasks }
                    onSubtasksChange={ show => ui.setTasksSubtasks(show) }
                    inTask={ scope !== undefined }
                    createHint={ isFull ? DEPTH_LIMIT_HINT : undefined }
                    onCreate={ createTask }
                    filter={ filter }
                    onFilterChange={ setFilter }
                    statuses={ project.statuses }
                    agents={ agentOptions(runsOfTask) }
                    searchRef={ searchField }
                    onSearchExit={ exitSearch }
                    isFilterOpen={ isFilterOpen }
                    onFilterOpenChange={ onFilterOpenChange }
                />

                { scope && (
                    <ScopeHeader
                        task={ scope }
                        status={ project.statuses.find(status => status.id === scope.statusId) }
                        rollUp={ tree.rollUp(scope) }
                        canHaveChildren={ !isFull }
                        onCreate={ () => createIn(scope.id) }
                        onDetails={ () => nav.openTask(scope.id) }
                    />
                ) }

                { content.tasks.length === 0
                    ? (
                        <ScopeEmpty
                            isScope={ scope !== undefined }
                            isHidden={ content.total > 0 }
                            isFiltering={ isFiltering(filter) }
                            canHaveChildren={ !isFull }
                            onCreateSubtask={ () => scope && createIn(scope.id) }
                            onClearFilters={ () => setFilter(NO_FILTER) }
                        />
                    )
                    : (
                        <div ref={ region } className={ styles.region } onClickCapture={ onClickCapture } onPointerMove={ onPointerMove } onFocus={ onFocus }>
                            { content.mode === 'tree'
                                ? <TaskList rows={ content.rows } statuses={ project.statuses } runsOfTask={ runsOfTask } notesOf={ notesOf } onOpenScope={ open } onToggle={ toggleFold } openId={ selected?.id ?? null } selectedIds={ cursor.selected } />
                                : <Board columns={ content.columns } runsOfTask={ runsOfTask } notesOf={ notesOf } onOpenScope={ open } openId={ selected?.id ?? null } selectedIds={ cursor.selected } onMove={ move } />
                            }
                        </div>
                    ) }
            </div>

            { selected && (
                <DetailPanel
                    key={ selected.id }
                    task={ selected }
                    taskRuns={ runsOfTask.get(selected.id) ?? [] }
                    titleRef={ titleField }
                    // Not for the task the screen is inside already: its sub-tasks are what is drawn.
                    onOpenSubtasks={ selected.id !== scope?.id && tree.childrenOf(selected.id).length > 0 ? () => open(selected.id) : undefined }
                    tree={ tree }
                    onCreateSubtask={ () => createIn(selected.id) }
                />
            ) }

            { picker && <PickerPopover anchor={ picker.anchor } { ...picker.request } onClose={ () => setPicker(null) } /> }
        </div>
    );
}
