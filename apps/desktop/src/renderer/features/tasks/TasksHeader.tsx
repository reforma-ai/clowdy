import { Button } from '@clowdy/components/Button';
import { SearchInput } from '@clowdy/components/Input';
import { Text } from '@clowdy/components/Text';
import { ToggleButtonGroup, ToggleButtonGroupItem } from '@clowdy/components/ToggleButtonGroup';
import { Columns, List, Plus } from '@clowdy/icons/14';

import { FilterPopover } from './FilterPopover';
import styles from './TasksHeader.module.css';

import type { Run, TaskStatus } from '@clowdy/protocol';
import type { TasksView } from '../../stores';
import type { TaskFilter } from './taskView';

export interface TasksHeaderProps {
    /** Source and project: `Internal · Car Rental`. */
    subtitle: string;
    view: TasksView;
    onViewChange: (view: TasksView) => void;
    onCreate: () => void;
    filter: TaskFilter;
    onFilterChange: (filter: TaskFilter) => void;
    statuses: readonly TaskStatus[];
    agents: readonly Run[];
}

/** The screen's header: title and source on the left; view switch, search, filter and "+ Task" on the right. */
export function TasksHeader({ subtitle, view, onViewChange, onCreate, filter, onFilterChange, statuses, agents }: TasksHeaderProps) {
    return (
        <header className={ styles.header }>
            <div className={ styles.titles }>
                <Text variant="heading-3" weight="semibold">Tasks</Text>
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
                    <ToggleButtonGroupItem value="board"><Columns />Board</ToggleButtonGroupItem>
                    <ToggleButtonGroupItem value="list"><List />List</ToggleButtonGroupItem>
                </ToggleButtonGroup>

                <SearchInput
                    className={ styles.search }
                    size="sm"
                    aria-label="Search tasks"
                    placeholder="Search tasks…"
                    value={ filter.query }
                    onChange={ (query: string) => onFilterChange({ ...filter, query }) }
                />

                <FilterPopover filter={ filter } onChange={ onFilterChange } statuses={ statuses } agents={ agents } />

                <Button color="primary" size="sm" onPress={ onCreate }>
                    <Plus />
                    Task
                </Button>
            </div>
        </header>
    );
}
