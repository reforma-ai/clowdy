import { Box } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';
import { use } from 'react';

import chipStyles from '../../shared/Chip.module.css';
import { StreamLinksContext } from '../StreamLinks';

import type { Task } from '@clowdy/protocol';

/** A task named in a message as a chip: cube icon and key, and a press opens the task. */
export function TaskKeyChip({ task, className }: { task: Pick<Task, 'id' | 'key' | 'title'>; className?: string }) {
    const { onOpenTask } = use(StreamLinksContext);

    return (
        <button type="button" className={ cn(chipStyles.chip, className) } title={ task.title } onClick={ () => onOpenTask?.(task.id) }>
            <span className={ chipStyles.icon }><Box width={ 12 } height={ 12 } /></span>
            <span className={ chipStyles.label }>{ task.key }</span>
        </button>
    );
}
