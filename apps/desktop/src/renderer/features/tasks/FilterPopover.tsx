import { Button } from '@clowdy/components/Button';
import { Checkbox } from '@clowdy/components/Checkbox';
import { Popover, PopoverTrigger } from '@clowdy/components/Popover';
import { Sliders } from '@clowdy/icons/14';

import { commandTooltip } from '../../hotkeys';
import { RunStatusPill } from '../../shared';
import styles from './FilterPopover.module.css';
import { StatusIcon } from './status';
import { facetCount, NO_FILTER, type TaskFilter } from './taskView';

import type { Run, TaskStatus } from '@clowdy/protocol';

export interface FilterPopoverProps {
    filter: TaskFilter;
    onChange: (filter: TaskFilter) => void;
    statuses: readonly TaskStatus[];
    /** The agents a person may filter by. */
    agents: readonly Run[];
    /** Whether the popover is open, for a key that opens it. Without it the popover keeps its own state. */
    isOpen?: boolean;
    onOpenChange?: (isOpen: boolean) => void;
}

function toggle<T>(list: readonly T[], value: T): T[] {
    return list.includes(value) ? list.filter(item => item !== value) : [...list, value];
}

/** "Filter": status and agent checkboxes in a popover. Nothing checked in a group means no narrowing by it. */
export function FilterPopover({ filter, onChange, statuses, agents, isOpen, onOpenChange }: FilterPopoverProps) {
    const facets = facetCount(filter);

    return (
        <PopoverTrigger isOpen={ isOpen } onOpenChange={ onOpenChange }>
            <Button
                variant="bordered"
                size="sm"
                aria-label={ facets > 0 ? `Filter, ${ facets } active` : 'Filter' }
                tooltip={ commandTooltip('Filter', 'tasks.filter') }
                data-filter-trigger
            >
                <Sliders />
                Filter
                { facets > 0 && <span className={ styles.count }>{ facets }</span> }
            </Button>
            <Popover placement="bottom end" width={ 300 } spacing="md" aria-label="Filter tasks">
                <div className={ styles.body }>
                    <div className={ styles.group }>
                        <span className={ styles.heading }>Status</span>
                        { statuses.map(status => (
                            <Checkbox
                                key={ status.id }
                                size="sm"
                                isSelected={ filter.statusIds.includes(status.id) }
                                onChange={ () => onChange({ ...filter, statusIds: toggle(filter.statusIds, status.id) }) }
                            >
                                <span className={ styles.optionLabel }>
                                    <StatusIcon category={ status.category } />
                                    { status.name }
                                </span>
                            </Checkbox>
                        )) }
                    </div>

                    <div className={ styles.group }>
                        <span className={ styles.heading }>Agent</span>
                        { agents.length === 0 && <span className={ styles.none }>No agent has worked on a task yet.</span> }
                        <div className={ styles.agents }>
                            { agents.map(run => (
                                <Checkbox
                                    key={ run.id }
                                    size="sm"
                                    isSelected={ filter.runIds.includes(run.id) }
                                    onChange={ () => onChange({ ...filter, runIds: toggle(filter.runIds, run.id) }) }
                                >
                                    <span className={ styles.option }>
                                        <span className={ styles.optionLabel }>{ run.name }</span>
                                        <RunStatusPill status={ run.status } reason={ run.statusReason } />
                                    </span>
                                </Checkbox>
                            )) }
                        </div>
                    </div>

                    { facets > 0 && (
                        <Button variant="filling" size="sm" onPress={ () => onChange({ ...NO_FILTER, query: filter.query }) }>Clear filters</Button>
                    ) }
                </div>
            </Popover>
        </PopoverTrigger>
    );
}
