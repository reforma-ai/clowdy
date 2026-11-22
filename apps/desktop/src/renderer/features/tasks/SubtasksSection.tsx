import { Button } from '@clowdy/components/Button';
import { Plus } from '@clowdy/icons/14';

import { Unavailable } from '../../shared/Unavailable';
import { None, Section } from './DetailSections';
import { StatusIcon } from './status';
import styles from './SubtasksSection.module.css';
import { RollUpChip } from './TaskChips';
import { DEPTH_LIMIT_HINT } from './taskTree';

import type { Task, TaskId, TaskStatus } from '@clowdy/protocol';
import type { Rollup } from './taskTree';

export interface SubtasksSectionProps {
    task: Pick<Task, 'key'>;
    /** The tasks directly inside the task, in workflow status order and then number (`TaskTree.childrenOf`). */
    subtasks: readonly Task[];
    /** The work inside the task over everything below it, at any depth (`TaskTree.rollUp`). */
    rollUp: Rollup | undefined;
    statuses: readonly TaskStatus[];
    /** The task can hold tasks: it is not at the last level the daemon allows. */
    canHaveChildren: boolean;
    /** Opens a sub-task in the panel. */
    onOpen: (taskId: TaskId) => void;
    /** Opens the "New task" dialog for a task inside this one. */
    onCreate: () => void;
}

/**
 * The tasks directly inside the task, each with its status, key and title, which opens it; the work done below them at any depth in the header, and a
 * button for a new one. Every task has the section, so the first sub-task is made from here: a task with nothing inside it says so, and one at the last level
 * has the button off with the reason.
 */
export function SubtasksSection({ task, subtasks, rollUp, statuses, canHaveChildren, onOpen, onCreate }: SubtasksSectionProps) {
    return (
        <Section title="Sub-tasks" aside={ rollUp && <RollUpChip rollUp={ rollUp } taskKey={ task.key } /> }>
            { subtasks.length === 0 && <None>No sub-tasks yet</None> }

            { subtasks.length > 0 && (
                <div className={ styles.list }>
                    { subtasks.map((subtask) => {
                        const status = statuses.find(candidate => candidate.id === subtask.statusId);

                        return (
                            <button key={ subtask.id } type="button" className={ styles.row } onClick={ () => onOpen(subtask.id) } title={ subtask.title }>
                                { status
                                    ? <StatusIcon category={ status.category } />
                                    : <span aria-hidden className={ styles.noStatus } /> }
                                <span className={ styles.key }>{ subtask.key }</span>
                                <span className={ styles.title }>{ subtask.title }</span>
                            </button>
                        );
                    }) }
                </div>
            ) }

            {/* Its own line, so the stand-in that carries the hint is as wide as the button and not as wide as the section. */}
            <div className={ styles.action }>
                <Unavailable label="New sub-task" hint={ canHaveChildren ? undefined : DEPTH_LIMIT_HINT }>
                    <Button variant="bordered" size="sm" isDisabled={ !canHaveChildren } onPress={ onCreate }>
                        <Plus />
                        New sub-task
                    </Button>
                </Unavailable>
            </div>
        </Section>
    );
}
