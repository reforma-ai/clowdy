import { User } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';

import { useProjectUi } from '../stores';
import styles from './Chip.module.css';
import { useRunLabel } from './useRunLabel';

import type { Run } from '@clowdy/protocol';

export interface AgentChipProps {
    run: Pick<Run, 'id' | 'name' | 'summary' | 'origin'>;
    /** What a press does. By default it opens the run in the Agents section. */
    onPress?: () => void;
    className?: string;
}

/** A run as a chip: person icon and how the person reads the run (`runLabel`: the chat's title, or a sub-agent's type). */
export function AgentChip({ run, onPress, className }: AgentChipProps) {
    const ui = useProjectUi();
    const label = useRunLabel()(run);

    return (
        <button
            type="button"
            className={cn(styles.chip, className)}
            title={run.summary || label}
            onClick={onPress ?? (() => ui.openRun(run.id))}
        >
            <span className={styles.icon}>
                <User width={12} height={12} />
            </span>
            <span className={styles.label}>{label}</span>
        </button>
    );
}
