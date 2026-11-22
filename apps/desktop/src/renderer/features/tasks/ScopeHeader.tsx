import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { Box, Plus } from '@clowdy/icons/14';

import { Unavailable } from '../../shared/Unavailable';
import styles from './ScopeHeader.module.css';
import { StatusPill } from './status';
import { RollUpChip } from './TaskChips';
import { DEPTH_LIMIT_HINT } from './taskTree';

import type { Task, TaskStatus } from '@clowdy/protocol';
import type { Rollup } from './taskTree';

export interface ScopeHeaderProps {
    /** The task whose insides the screen shows. */
    task: Task;
    status: TaskStatus | undefined;
    /** The work inside the task, over everything below it. */
    rollUp: Rollup | undefined;
    /** The task can hold tasks: it is not at the last level the daemon allows. */
    canHaveChildren: boolean;
    /** Opens the "New task" dialog for a task inside this one. */
    onCreate: () => void;
    /** Opens the detail panel for the task itself. */
    onDetails: () => void;
}

/**
 * The strip over a task's own board or list: the task's key, title, status and the work inside it, and two buttons, "New sub-task" and "Details".
 * It only shows the task and opens things; the task is edited in its detail panel.
 */
export function ScopeHeader({ task, status, rollUp, canHaveChildren, onCreate, onDetails }: ScopeHeaderProps) {
    return (
        <section className={ styles.scope } aria-label={ `Inside ${ task.key }` }>
            <span className={ styles.key }>
                <Box aria-hidden width={ 12 } height={ 12 } />
                { task.key }
            </span>
            <Text variant="heading-5" truncate className={ styles.title }>{ task.title }</Text>
            <StatusPill status={ status } />
            { rollUp && <RollUpChip rollUp={ rollUp } taskKey={ task.key } /> }

            <span className={ styles.spacer } />

            <Unavailable label="New sub-task" hint={ canHaveChildren ? undefined : DEPTH_LIMIT_HINT }>
                <Button variant="bordered" size="sm" isDisabled={ !canHaveChildren } onPress={ onCreate }>
                    <Plus />
                    New sub-task
                </Button>
            </Unavailable>
            <Button variant="bordered" size="sm" onPress={ onDetails }>Details</Button>
        </section>
    );
}
