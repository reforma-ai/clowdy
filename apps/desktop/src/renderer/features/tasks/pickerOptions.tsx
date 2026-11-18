import { StatusIcon } from './status';

import type { Task, TaskStatus } from '@clowdy/protocol';
import type { PickerOption } from '../../shared/PickerPopover';

/** Every status of the workflow, in order, each with its icon. */
export function statusOptions(statuses: readonly TaskStatus[]): PickerOption[] {
    return statuses.map(status => ({ id: status.id, label: status.name, icon: <StatusIcon category={ status.category } /> }));
}

/** Tasks as picker rows: the status icon, then the key and the title, which is what the "Add dependency" list says too. */
export function taskOptions(tasks: readonly Task[], statuses: readonly TaskStatus[]): PickerOption[] {
    return tasks.map((task) => {
        const status = statuses.find(candidate => candidate.id === task.statusId);

        return { id: task.id, label: `${ task.key }  ${ task.title }`, icon: status && <StatusIcon category={ status.category } /> };
    });
}
