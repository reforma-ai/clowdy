import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { Plus } from '@clowdy/icons/14';

import styles from './ScopeEmpty.module.css';

export interface ScopeEmptyProps {
    /** The screen is inside a task, and not at the project's roots. */
    isScope: boolean;
    /** There is something to show and the search or filters hide all of it. */
    isHidden: boolean;
    /** The filters narrow the view, so there is something to clear. */
    isFiltering: boolean;
    /** The task the screen is inside can hold tasks: it is not at the last level the daemon allows. */
    canHaveChildren: boolean;
    /** Opens the dialog for a task inside the scope. */
    onCreateSubtask: () => void;
    onClearFilters: () => void;
}

/** What the screen says in place of the board or the list when it has nothing to draw: an empty project, an empty task, or a filter that hides everything. */
export function ScopeEmpty({ isScope, isHidden, isFiltering, canHaveChildren, onCreateSubtask, onClearFilters }: ScopeEmptyProps) {
    if (isHidden) {
        return (
            <div className={ styles.message }>
                <Text variant="heading-4">No tasks match</Text>
                <Text color="secondary">Try a different search or clear the filters</Text>
                { isFiltering && <Button variant="bordered" size="sm" onPress={ onClearFilters }>Clear filters</Button> }
            </div>
        );
    }

    if (!isScope) {
        return (
            <div className={ styles.message }>
                <Text variant="heading-4">No tasks yet</Text>
                <Text color="secondary">Create one, or ask the orchestrator in a chat to plan the work</Text>
            </div>
        );
    }

    return (
        <div className={ styles.message }>
            <Text variant="heading-4">No sub-tasks yet</Text>
            <Text color="secondary">{ canHaveChildren ? 'Split this task into smaller ones' : 'This task is at the last level, so it cannot hold tasks' }</Text>
            { canHaveChildren && (
                <Button variant="bordered" size="sm" onPress={ onCreateSubtask }>
                    <Plus />
                    New sub-task
                </Button>
            ) }
        </div>
    );
}
