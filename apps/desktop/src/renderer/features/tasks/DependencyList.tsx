import { Button } from '@clowdy/components/Button';
import { Checkbox } from '@clowdy/components/Checkbox';
import { ListBoxItem } from '@clowdy/components/List';
import { Select } from '@clowdy/components/Select';
import { Close, Plus } from '@clowdy/icons/14';

import styles from './DependencyList.module.css';

import type { Task, TaskId, TaskStatus } from '@clowdy/protocol';

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
}

/** The tasks one depends on, each with a checkbox that is ticked once that task is done, and a picker to add more. */
export function DependencyList({ ids, tasks, statuses, candidates, onAdd, onRemove, onOpen }: DependencyListProps) {
    return (
        <div className={ styles.list }>
            { ids.map((id) => {
                const dependency = tasks.get(id);
                const isDone = statuses.find(status => status.id === dependency?.statusId)?.category === 'done';

                return (
                    <div key={ id } className={ styles.row }>
                        <Checkbox size="sm" isReadOnly excludeFromTabOrder isSelected={ isDone } aria-label={ isDone ? 'Done' : 'Not done' } className={ styles.check } />
                        { dependency
                            ? (
                                <button type="button" className={ styles.open } disabled={ !onOpen } onClick={ () => onOpen?.(id) } title={ dependency.title }>
                                    <span className={ styles.key }>{ dependency.key }</span>
                                    <span className={ styles.title }>{ dependency.title }</span>
                                </button>
                            )
                            : <span className={ styles.gone }>Removed task</span> }
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
                    </div>
                );
            }) }

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
        </div>
    );
}
