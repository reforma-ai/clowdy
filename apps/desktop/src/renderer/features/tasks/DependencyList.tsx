import { Button } from '@clowdy/components/Button';
import { Checkbox } from '@clowdy/components/Checkbox';
import { ListBoxItem } from '@clowdy/components/List';
import { Select } from '@clowdy/components/Select';
import { Close, Plus } from '@clowdy/icons/14';

import styles from './DependencyList.module.css';
import { dependencyState } from './taskView';

import type { Task, TaskId, TaskStatus } from '@clowdy/protocol';
import type { TaskReading } from './useTaskReadings';

export interface DependencyListProps {
    ids: readonly TaskId[];
    tasks: ReadonlyMap<TaskId, Task>;
    statuses: readonly TaskStatus[];
    /** The tasks that may still be added; see `dependencyCandidates`. */
    candidates: readonly Task[];
    onAdd: (taskId: TaskId) => void;
    onRemove: (taskId: TaskId) => void;
    /** Opens a dependency. A dialog has nowhere to go and leaves it out. */
    onOpen?: (taskId: TaskId) => void;
    /**
     * What the project and the daemon say of the dependencies the board does not hold (`useTaskReadings`): an archived task is a dependency that is done, and shows with its
     * key and title. Without it such a dependency is a removed task, which is all a dialog for a task that is not made yet can say.
     */
    readings?: ReadonlyMap<TaskId, TaskReading>;
    /** The list is only read: a dependency of an archived task has no Remove and nothing is added. */
    isReadOnly?: boolean;
}

/** What stands in the place of a dependency that no task is known for. */
function goneText(reading: TaskReading | undefined): string {
    if (reading?.status === 'loading') return 'Loading…';

    return reading?.status === 'failed' ? 'Couldn\'t read the task' : 'Removed task';
}

/** The tasks one depends on, each with a checkbox that is ticked once that task is closed, Done or Canceled (an archived one is), and a picker to add more. */
export function DependencyList({ ids, tasks, statuses, candidates, onAdd, onRemove, onOpen, readings, isReadOnly = false }: DependencyListProps) {
    return (
        <div className={ styles.list }>
            { ids.map((id) => {
                const reading = readings?.get(id);
                const dependency = tasks.get(id) ?? (reading?.status === 'ready' ? reading.task : undefined);
                const { resolved, label } = dependencyState(statuses.find(status => status.id === dependency?.statusId)?.category);

                return (
                    <div key={ id } className={ styles.row }>
                        <Checkbox size="sm" isReadOnly excludeFromTabOrder isSelected={ resolved } aria-label={ label } className={ styles.check } />
                        { dependency
                            ? (
                                <button type="button" className={ styles.open } disabled={ !onOpen } onClick={ () => onOpen?.(id) } title={ dependency.title }>
                                    <span className={ styles.key }>{ dependency.key }</span>
                                    <span className={ styles.title }>{ dependency.title }</span>
                                    { dependency.archivedAt !== undefined && <span className={ styles.archived }>Archived</span> }
                                </button>
                            )
                            : <span className={ styles.gone }>{ goneText(reading) }</span> }
                        { !isReadOnly && (
                            <Button
                                iconOnly
                                size="xs"
                                variant="filling"
                                className={ styles.remove }
                                aria-label={ `Remove dependency ${ dependency?.key ?? '' }`.trim() }
                                onPress={ () => onRemove(id) }
                            >
                                <Close />
                            </Button>
                        ) }
                    </div>
                );
            }) }

            { !isReadOnly && (
                <Select
                    aria-label="Add dependency"
                    size="sm"
                    variant="bordered"
                    icon={ <Plus /> }
                    placeholder="Add dependency…"
                    showSearch
                    searchPlaceholder="Find a task…"
                    isDisabled={ candidates.length === 0 }
                    items={ candidates }
                    selectedKey={ null }
                    onSelectionChange={ (key: unknown) => typeof key === 'string' && onAdd(key) }
                >
                    { task => <ListBoxItem id={ task.id } text={ `${ task.key }  ${ task.title }` } /> }
                </Select>
            ) }
        </div>
    );
}
