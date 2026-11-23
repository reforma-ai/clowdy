import { copyWithFeedback } from '@clowdy/components/CopyButton';
import { toast } from '@clowdy/components/Toast';

import type { CommandResult, TaskId } from '@clowdy/protocol';
import type { CommandInput } from '../../daemon/transport';
import type { RootStore } from '../../stores';

/** Sends a command. A refusal is shown to the person and also returned, for a caller that has more to undo. */
export async function sendCommand(root: RootStore, input: CommandInput): Promise<CommandResult> {
    const result = await root.command(input);

    if (!result.ok) toast.error({ message: result.error.message });

    return result;
}

/**
 * Sends one command per target, one after the other so the daemon sees them in the order the person sees the tasks, and returns the results in that order.
 * A refusal does not stop the rest. The refusals are reported once, in one toast that says how many failed and why the first did,
 * because a bulk action over twenty tasks must not put twenty toasts on the screen.
 */
export async function sendEach(root: RootStore, inputs: readonly CommandInput[]): Promise<CommandResult[]> {
    const results: CommandResult[] = [];

    for (const input of inputs) results.push(await root.command(input));

    const refused = results.flatMap(result => (result.ok ? [] : [result.error.message]));

    if (refused.length > 0) {
        toast.error({
            message:
                inputs.length === 1
                    ? refused[0]
                    : `${refused.length} of ${inputs.length} changes failed: ${refused[0]}`,
        });
    }

    return results;
}

/** Tasks whose start is in flight. The daemon allows one executing run per task, and the second of two quick presses would only be refused. */
const starting = new Set<TaskId>();

/** Starts the task with an agent, as the panel's Start button and the Cmd/Ctrl+Enter key do. Resolves to whether the daemon took it. */
export async function startTask(root: RootStore, taskId: TaskId): Promise<boolean> {
    if (starting.has(taskId)) return false;

    starting.add(taskId);

    try {
        return (await sendCommand(root, { type: 'task.start', taskId })).ok;
    } finally {
        starting.delete(taskId);
    }
}

/** Puts the text on the clipboard and says so in a toast, or says it could not when the system refuses the write. */
export function copyWithToast(text: string, message: string): void {
    copyWithFeedback(text, () => toast.success({ message }));
}
