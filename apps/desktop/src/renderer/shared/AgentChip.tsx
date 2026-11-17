import { User } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';

import { useProjectUi } from '../stores';
import styles from './Chip.module.css';

import type { Run } from '@clowdy/protocol';

export interface AgentChipProps {
    run: Pick<Run, 'id' | 'name' | 'summary'>;
    /** What a press does. By default it opens the run in the Agents section. */
    onPress?: () => void;
    className?: string;
}

/** A run as a chip: person icon and its name (`Executor 07`). */
export function AgentChip({ run, onPress, className }: AgentChipProps) {
    const ui = useProjectUi();

    return (
        <button
            type="button"
            className={ cn(styles.chip, className) }
            title={ run.summary || run.name }
            onClick={ onPress ?? (() => ui.openRun(run.id)) }
        >
            <span className={ styles.icon }><User width={ 12 } height={ 12 } /></span>
            <span className={ styles.label }>{ run.name }</span>
        </button>
    );
}
