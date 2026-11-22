import { Checkbox, Split } from '@clowdy/icons/12';

import styles from './TaskChips.module.css';

import type { Checklist, Rollup } from './taskTree';

/** `2/5`. */
const progress = ({ done, total }: Rollup | Checklist) => `${ done }/${ total }`;

export interface RollUpChipProps {
    rollUp: Rollup;
    /** The task the work is inside, to say what a press opens. */
    taskKey: string;
    /** Opens the task's own scope. Without it the chip only shows the numbers. */
    onPress?: () => void;
}

/**
 * The work inside a task: the tasks done out of the tasks that count (`2/5`). A press opens the task's own scope, so it is a control of the card or row:
 * the screen's click handler leaves it alone (`data-task-control`) and it sits above the card's hit area.
 */
export function RollUpChip({ rollUp, taskKey, onPress }: RollUpChipProps) {
    const content = (
        <>
            <Split aria-hidden className={ styles.icon } />
            <span className={ styles.label }>{ progress(rollUp) }</span>
        </>
    );
    const done = rollUp.done === rollUp.total || undefined;
    const title = `${ rollUp.done } of ${ rollUp.total } sub-tasks done`;

    // `title` alone is not read out, and `3/8` means nothing without it.
    if (!onPress) return <span className={ styles.chip } data-done={ done } role="img" aria-label={ title } title={ title }>{ content }</span>;

    return (
        <button
            type="button"
            className={ styles.chip }
            data-pressable
            data-done={ done }
            // `TASK_CONTROL` in `taskCommands`: the screen and the keys leave what carries it to itself.
            data-task-control=""
            aria-label={ `Open sub-tasks of ${ taskKey }, ${ title }` }
            title={ title }
            // The row and the card read pointer and key presses of their own, and a press here is not on the task.
            onClick={ (event) => {
                event.stopPropagation();
                onPress();
            } }
            onPointerDown={ event => event.stopPropagation() }
            onKeyDown={ event => event.stopPropagation() }
        >
            { content }
        </button>
    );
}

/** The steps ticked in the description (`3/8`). A card's own press is the press on the task, so the chip is not a control. */
export function ChecklistChip({ checklist }: { checklist: Checklist }) {
    const title = `${ checklist.done } of ${ checklist.total } steps done`;

    return (
        <span className={ styles.chip } data-done={ checklist.done === checklist.total || undefined } role="img" aria-label={ title } title={ title }>
            <Checkbox aria-hidden className={ styles.icon } />
            <span className={ styles.label }>{ progress(checklist) }</span>
        </span>
    );
}
