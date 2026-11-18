import { toast } from '@clowdy/components/Toast';

import type { CommandResult } from '@clowdy/protocol';
import type { CommandInput } from '../../daemon/transport';
import type { RootStore } from '../../stores';

/** Sends a command and tells the person when the daemon refused it. */
export async function perform(root: RootStore, input: CommandInput): Promise<CommandResult> {
    const result = await root.command(input);

    if (!result.ok) toast.error({ message: result.error.message });

    return result;
}
