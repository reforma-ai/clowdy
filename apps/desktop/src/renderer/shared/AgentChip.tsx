import { Chip } from '@clowdy/components/Chip';
import { User } from '@clowdy/icons/14';

import { useProjectUi } from '../stores';
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
        <Chip
            className={className}
            icon={<User width={12} height={12} />}
            tooltip={label}
            onPress={onPress ?? (() => ui.openRun(run.id))}
        >
            {label}
        </Chip>
    );
}
