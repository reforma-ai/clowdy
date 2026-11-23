import { Button } from '@clowdy/components/Button';
import { useRef, useState } from 'react';

import { PickerPopover } from '../../shared/PickerPopover';
import { Section } from './DetailSections';
import styles from './ParentRow.module.css';
import { NO_PARENT, parentOptions } from './pickerOptions';
import { StatusIcon } from './status';

import type { Task, TaskId, TaskStatus } from '@clowdy/protocol';

export interface ParentRowProps {
    task: Pick<Task, 'id' | 'parentId'>;
    /** The task this one is inside, when the project holds it. */
    parent: Task | undefined;
    /** The tasks it may be moved under (`parentCandidates`), its present parent among them. */
    candidates: readonly Task[];
    statuses: readonly TaskStatus[];
    /** Opens a task in the panel. */
    onOpen: (taskId: TaskId) => void;
    /** Moves the task under the task, or out of its parent with `null`. Not called for the parent it has already. */
    onChange: (parentId: TaskId | null) => void;
}

/**
 * Where the task sits: its parent, which opens, and a picker to change it. A root says "No parent" and has the picker too. The picker lists "No parent" first and then
 * the tasks the task may go under, so the person never offers the daemon a loop or a level past the limit; what the daemon still refuses it says in a toast.
 */
export function ParentRow({ task, parent, candidates, statuses, onOpen, onChange }: ParentRowProps) {
    const trigger = useRef<HTMLButtonElement>(null);
    const [anchor, setAnchor] = useState<Element | null>(null);
    const status = parent && statuses.find(candidate => candidate.id === parent.statusId);
    // The parent is set but is not among the project's tasks (it is not on the board): there is nothing to open.
    const isMissing = parent === undefined && task.parentId !== undefined;

    const pick = (id: string) => {
        const next = id === NO_PARENT ? null : id;

        if (next !== (task.parentId ?? null)) onChange(next);
    };

    return (
        <Section title="Parent">
            <div className={styles.row}>
                {parent ? (
                    <button
                        type="button"
                        className={styles.open}
                        onClick={() => onOpen(parent.id)}
                        title={parent.title}
                    >
                        {status && <StatusIcon category={status.category} />}
                        <span className={styles.key}>{parent.key}</span>
                        <span className={styles.title}>{parent.title}</span>
                    </button>
                ) : (
                    <span className={styles.none}>{isMissing ? 'Parent is not on the board' : 'No parent'}</span>
                )}

                <Button
                    ref={trigger}
                    size="xs"
                    variant="bordered"
                    isDisabled={candidates.length === 0 && task.parentId === undefined}
                    aria-label={task.parentId === undefined ? 'Set parent' : 'Change parent'}
                    onPress={() => setAnchor(trigger.current)}
                >
                    {task.parentId === undefined ? 'Set parent' : 'Change'}
                </Button>
            </div>

            {anchor && (
                <PickerPopover
                    anchor={anchor}
                    options={parentOptions(candidates, statuses)}
                    selectedIds={[task.parentId ?? NO_PARENT]}
                    aria-label="Parent"
                    placeholder="Find a task…"
                    onPick={pick}
                    onClose={() => setAnchor(null)}
                />
            )}
        </Section>
    );
}
