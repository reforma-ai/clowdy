import { use } from 'react';

import { TaskChipButton } from '../../shared/TaskChip';
import { StreamLinksContext } from '../StreamLinks';

import type { Task } from '@clowdy/protocol';

/** A task named in a message, opening it through the stream's links. */
export function TaskKeyChip({ task, className }: { task: Pick<Task, 'id' | 'key' | 'title'>; className?: string }) {
    const { onOpenTask } = use(StreamLinksContext);

    return <TaskChipButton task={task} className={className} onPress={() => onOpenTask?.(task.id)} />;
}
