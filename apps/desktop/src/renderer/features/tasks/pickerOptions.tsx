import { Close } from '@clowdy/icons/14';

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

/** The id of the "No parent" row of a parent picker. It is no task's id, so it cannot be mistaken for a parent. */
export const NO_PARENT = '@no-parent';

/** The rows of a parent picker: "No parent" first, then the tasks that may be the parent (`parentCandidates`), each by its key and title. */
export function parentOptions(candidates: readonly Task[], statuses: readonly TaskStatus[]): PickerOption[] {
    return [{ id: NO_PARENT, label: 'No parent', icon: <Close aria-hidden /> }, ...taskOptions(candidates, statuses)];
}
