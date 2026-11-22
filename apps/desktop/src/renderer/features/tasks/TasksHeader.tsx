import { Breadcrumb } from '@clowdy/components/Breadcrumb';
import { Button } from '@clowdy/components/Button';
import { SearchInput } from '@clowdy/components/Input';
import { Text } from '@clowdy/components/Text';
import { ToggleButtonGroup, ToggleButtonGroupItem } from '@clowdy/components/ToggleButtonGroup';
import { Archive, Columns, Layers, List, Plus } from '@clowdy/icons/14';

import { commandHint, CommandHotkey, commandTooltip } from '../../hotkeys';
import { SCREEN_TITLE } from '../../shared';
import { Unavailable } from '../../shared/Unavailable';
import { FilterPopover } from './FilterPopover';
import styles from './TasksHeader.module.css';

import type { Run, Task, TaskId, TaskStatus } from '@clowdy/protocol';
import type { KeyboardEvent, Ref } from 'react';
import type { TasksView } from '../../stores';
import type { TaskFilter } from './taskView';

/** A task of the path, which shows by its key: the title of the one the screen is in is in the scope's own header below. */
export type TaskCrumb = Pick<Task, 'id' | 'key'>;

export interface TasksHeaderProps {
    /** Where the tasks come from: `Internal`, `Internal + Linear`. Only the project's own page says it. */
    subtitle: string;
    /** The place of a scope: the tasks above it, the root first, and the task itself. Without it the screen is at the project's roots and the title says `Tasks`. */
    path?: { ancestors: readonly TaskCrumb[]; task: TaskCrumb };
    /** A press on a crumb: show the insides of that task, or the project's roots with `null`. */
    onOpenScope: (taskId: TaskId | null) => void;
    view: TasksView;
    onViewChange: (view: TasksView) => void;
    /** The board draws the tasks below the first level too. Only the board has the choice: the list is always a tree. */
    showSubtasks: boolean;
    onSubtasksChange: (show: boolean) => void;
    /** The button makes a sub-task of the task the screen is inside, and says so; without it, a task of the roots. */
    inTask: boolean;
    /** Why the button is off (the task is at the last level), or nothing while it works. */
    createHint?: string;
    onCreate: () => void;
    filter: TaskFilter;
    onFilterChange: (filter: TaskFilter) => void;
    statuses: readonly TaskStatus[];
    agents: readonly Run[];
    /** The search field, for the key that puts the keyboard in it. */
    searchRef: Ref<HTMLInputElement | null>;
    /** The person is done searching (Enter, or Esc with nothing left to clear) and the keyboard goes back to the list. */
    onSearchExit: () => void;
    isFilterOpen: boolean;
    onFilterOpenChange: (isOpen: boolean) => void;
    /** The screen shows the project's archive in place of the scope. The scope's path, the view, the search and the filter and the new-task button are for the scope, so they leave. */
    isArchive: boolean;
    onArchiveChange: (isArchive: boolean) => void;
}

/**
 * The screen's header: title and source on the left, or the path of the scope in their place; view switch, the sub-tasks toggle of the board, search, filter,
 * the Archive toggle and "+ Task" on the right, which is "+ Sub-task" inside a task. With the archive on, the title and the Archive toggle are all that is left.
 */
export function TasksHeader({ subtitle, path, onOpenScope, view, onViewChange, showSubtasks, onSubtasksChange, inTask, createHint, onCreate, filter, onFilterChange, statuses, agents, searchRef, onSearchExit, isFilterOpen, onFilterOpenChange, isArchive, onArchiveChange }: TasksHeaderProps) {
    // One key switches the view, so both items carry its hint. A hint on the other item alone would move between them on every switch and rebuild the button that was just pressed.
    const switchView = commandTooltip('Switch view', 'tasks.view.toggle');
    const createLabel = inTask ? 'New sub-task' : 'New task';

    // Esc clears the text first (the field does that and marks the event handled), and leaves when there is none.
    // Enter is taken here: its keypress would go to the card that has the keyboard by then, and press it.
    const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') event.preventDefault();

        if (event.key === 'Enter' || (event.key === 'Escape' && !event.defaultPrevented)) onSearchExit();
    };

    return (
        <header className={ styles.header }>
            <div className={ styles.titles }>
                { path && !isArchive
                    ? (
                        <Breadcrumb variant={ SCREEN_TITLE } aria-label="Task path">
                            <Breadcrumb.Link key="tasks" onPress={ () => onOpenScope(null) }>Tasks</Breadcrumb.Link>
                            { path.ancestors.map(crumb => <Breadcrumb.Link key={ crumb.id } onPress={ () => onOpenScope(crumb.id) }>{ crumb.key }</Breadcrumb.Link>) }
                            <Breadcrumb.Page key={ path.task.id }>{ path.task.key }</Breadcrumb.Page>
                        </Breadcrumb>
                    )
                    : (
                        <>
                            <Text variant={ SCREEN_TITLE }>Tasks</Text>
                            <Text color="secondary" truncate>{ subtitle }</Text>
                        </>
                    ) }
            </div>

            <div className={ styles.toolbar }>
                { !isArchive && (
                    <>
                        <ToggleButtonGroup
                            aria-label="View"
                            size="sm"
                            selectedKeys={ [view] }
                            onSelectionChange={ (keys) => {
                                const next = (['board', 'list'] as const).find(candidate => keys.has(candidate));

                                if (next) onViewChange(next);
                            } }
                        >
                            <ToggleButtonGroupItem value="board" tooltip={ switchView }><Columns />Board</ToggleButtonGroupItem>
                            <ToggleButtonGroupItem value="list" tooltip={ switchView }><List />List</ToggleButtonGroupItem>
                        </ToggleButtonGroup>

                        {/* One item that is on or off: the group may be empty. */}
                        { view === 'board' && (
                            <ToggleButtonGroup
                                aria-label="Sub-tasks"
                                size="sm"
                                disallowEmptySelection={ false }
                                selectedKeys={ showSubtasks ? ['subtasks'] : [] }
                                onSelectionChange={ keys => onSubtasksChange(keys.has('subtasks')) }
                            >
                                <ToggleButtonGroupItem value="subtasks" tooltip="Show the tasks inside tasks on the board too"><Layers />Sub-tasks</ToggleButtonGroupItem>
                            </ToggleButtonGroup>
                        ) }

                        <SearchInput
                            className={ styles.search }
                            size="sm"
                            aria-label="Search tasks"
                            placeholder="Search tasks…"
                            value={ filter.query }
                            onChange={ (query: string) => onFilterChange({ ...filter, query }) }
                            inputRef={ searchRef }
                            onKeyDown={ onSearchKeyDown }
                        >
                            {/* While there is text the field's own clear button takes this place. */}
                            { filter.query === '' && commandHint('tasks.search') && <span slot="suffix" className={ styles.searchHint }><CommandHotkey id="tasks.search" size="xs" /></span> }
                        </SearchInput>

                        <FilterPopover
                            filter={ filter }
                            onChange={ onFilterChange }
                            statuses={ statuses }
                            agents={ agents }
                            isOpen={ isFilterOpen }
                            onOpenChange={ onFilterOpenChange }
                        />
                    </>
                ) }

                {/* One item that is on or off, like the sub-tasks: the archive in place of the scope, and the scope as it was when it is off. */}
                <ToggleButtonGroup
                    aria-label="Archive"
                    size="sm"
                    disallowEmptySelection={ false }
                    selectedKeys={ isArchive ? ['archive'] : [] }
                    onSelectionChange={ keys => onArchiveChange(keys.has('archive')) }
                >
                    <ToggleButtonGroupItem value="archive" tooltip="Show the archived tasks"><Archive />Archive</ToggleButtonGroupItem>
                </ToggleButtonGroup>

                { !isArchive && (
                    <Unavailable label={ createLabel } hint={ createHint } placement="bottom">
                        <Button color="primary" size="sm" isDisabled={ createHint !== undefined } tooltip={ createHint === undefined ? commandTooltip(createLabel, 'tasks.create') : undefined } onPress={ onCreate }>
                            <Plus />
                            { inTask ? 'Sub-task' : 'Task' }
                        </Button>
                    </Unavailable>
                ) }
            </div>
        </header>
    );
}
