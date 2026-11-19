import { chatOfRun } from '../agents/agentTree';
import { perform } from './commands';

import type { Chat, ChatId, RunId } from '@clowdy/protocol';
import type { ProjectState, ProjectUi, RootStore } from '../../stores';

/**
 * Puts the chat in the archive and tells the person when the daemon refused (its agents are working). The chat that is open goes out of
 * sight with it, so the page moves on to the first chat that is still listed.
 */
export async function archiveChat(root: RootStore, ui: ProjectUi, chat: Chat, isOpen: boolean): Promise<void> {
    const result = await perform(root, { type: 'chat.setArchived', chatId: chat.id, archived: true });

    if (result.ok && isOpen) ui.openChat(null);
}

/** Brings the chat out of the archive, into the list. False when the daemon refused (the person has been told). */
export async function unarchiveChat(root: RootStore, chat: Chat): Promise<boolean> {
    return (await perform(root, { type: 'chat.setArchived', chatId: chat.id, archived: false })).ok;
}

/**
 * Shows the chat in the Agents section. A chat in the archive has no row and no page, so a link to one (a chip, a task's chat) brings it back
 * first, as picking it in the archive's list does.
 */
export async function openChat(root: RootStore, project: ProjectState, ui: ProjectUi, chatId: ChatId): Promise<void> {
    const chat = project.chats.get(chatId);

    if (chat?.archivedAt !== undefined && !(await unarchiveChat(root, chat))) return;

    ui.openChat(chatId);
}

/** Shows the run below its chat in the Agents section, bringing the chat out of the archive first when it is in it. */
export async function openRun(root: RootStore, project: ProjectState, ui: ProjectUi, runId: RunId): Promise<void> {
    const run = project.runs.get(runId);
    const owner = run ? chatOfRun(project.chats.values(), run) : undefined;

    if (owner?.archivedAt !== undefined && !(await unarchiveChat(root, owner))) return;

    ui.openRun(runId);
}
