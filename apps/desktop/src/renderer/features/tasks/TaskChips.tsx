import { Chip } from '@clowdy/components/Chip';
import { RowControls } from '@clowdy/components/List';
import { Checkbox, Split } from '@clowdy/icons/12';

import styles from './TaskChips.module.css';

import type { Checklist, Rollup } from './taskTree';

/** `2/5`. */
const progress = ({ done, total }: Rollup | Checklist) => `${done}/${total}`;

/** A finished count reads green; the rest is the plain chat chip. */
const toneOf = ({ done, total }: Rollup | Checklist) => (done === total ? 'success' : undefined);

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
    const title = `${rollUp.done} of ${rollUp.total} sub-tasks done`;

    // `title` alone is not read out, and `3/8` means nothing without it.
    if (!onPress)
        return (
            <Chip icon={<Split />} tone={toneOf(rollUp)} role="img" aria-label={title} title={title}>
                {progress(rollUp)}
            </Chip>
        );

    return (
        // `TASK_CONTROL` in `taskCommands`: the screen and the keys leave what carries it to itself, and the row's own handlers never see the press.
        <RowControls className={styles.control} data-task-control="">
            <Chip
                icon={<Split />}
                tone={toneOf(rollUp)}
                aria-label={`Open sub-tasks of ${taskKey}, ${title}`}
                tooltip={title}
                onPress={onPress}
            >
                {progress(rollUp)}
            </Chip>
        </RowControls>
    );
}

/** The steps ticked in the description (`3/8`). A card's own press is the press on the task, so the chip is not a control. */
export function ChecklistChip({ checklist }: { checklist: Checklist }) {
    const title = `${checklist.done} of ${checklist.total} steps done`;

    return (
        <Chip icon={<Checkbox />} tone={toneOf(checklist)} role="img" aria-label={title} title={title}>
            {progress(checklist)}
        </Chip>
    );
}
