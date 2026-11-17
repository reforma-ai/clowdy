import { toast } from '@clowdy/components/Toast';

import type { CommandResult } from '@clowdy/protocol';
import type { CommandInput } from '../../daemon/transport';
import type { RootStore } from '../../stores';

/** Sends a command. A refusal is shown to the person and also returned, for a caller that has more to undo. */
export async function sendCommand(root: RootStore, input: CommandInput): Promise<CommandResult> {
    const result = await root.command(input);

    if (!result.ok) toast.error({ message: result.error.message });

    return result;
}
