import { toast } from '@clowdy/components/Toast';

import type { Chat, CommandResult, ProjectId } from '@clowdy/protocol';
import type { CommandInput } from '../../daemon/transport';
import type { ProjectUi, RootStore } from '../../stores';

/** Sends a command and tells the person when the daemon refused it. */
export async function perform(root: RootStore, input: CommandInput): Promise<CommandResult> {
    const result = await root.command(input);

    if (!result.ok) toast.error({ message: result.error.message });

    return result;
}

/** Creates an empty chat and shows it. */
export async function startChat(root: RootStore, projectId: ProjectId, ui: ProjectUi): Promise<void> {
    const result = await perform(root, { type: 'chat.create', projectId });
    const { chat } = (result.ok ? result.data : {}) as { chat?: Chat };

    if (chat) ui.openChat(chat.id);
}
