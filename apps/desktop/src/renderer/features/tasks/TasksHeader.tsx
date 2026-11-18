import { Button } from '@clowdy/components/Button';
import { SearchInput } from '@clowdy/components/Input';
import { Text } from '@clowdy/components/Text';
import { ToggleButtonGroup, ToggleButtonGroupItem } from '@clowdy/components/ToggleButtonGroup';
import { Columns, List, Plus } from '@clowdy/icons/14';

import { commandHint, CommandHotkey, commandTooltip } from '../../hotkeys';
import { SCREEN_TITLE } from '../../shared';
import { FilterPopover } from './FilterPopover';
import styles from './TasksHeader.module.css';

import type { Run, TaskStatus } from '@clowdy/protocol';
import type { KeyboardEvent, Ref } from 'react';
import type { TasksView } from '../../stores';
import type { TaskFilter } from './taskView';

export interface TasksHeaderProps {
    /** Where the tasks come from: `Internal`, `Internal + Linear`. */
    subtitle: string;
    view: TasksView;
    onViewChange: (view: TasksView) => void;
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
}

/** The screen's header: title and source on the left; view switch, search, filter and "+ Task" on the right. */
export function TasksHeader({ subtitle, view, onViewChange, onCreate, filter, onFilterChange, statuses, agents, searchRef, onSearchExit, isFilterOpen, onFilterOpenChange }: TasksHeaderProps) {
    // One key switches the view, so both items carry its hint. A hint on the other item alone would move between them on every switch and rebuild the button that was just pressed.
    const switchView = commandTooltip('Switch view', 'tasks.view.toggle');

    // Esc clears the text first (the field does that and marks the event handled), and leaves when there is none.
    // Enter is taken here: its keypress would go to the card that has the keyboard by then, and press it.
    const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') event.preventDefault();

        if (event.key === 'Enter' || (event.key === 'Escape' && !event.defaultPrevented)) onSearchExit();
    };

    return (
        <header className={ styles.header }>
            <div className={ styles.titles }>
                <Text variant={ SCREEN_TITLE }>Tasks</Text>
                <Text color="secondary" truncate>{ subtitle }</Text>
            </div>

            <div className={ styles.toolbar }>
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

                <Button color="primary" size="sm" tooltip={ commandTooltip('New task', 'tasks.create') } onPress={ onCreate }>
                    <Plus />
                    Task
                </Button>
            </div>
        </header>
    );
}
