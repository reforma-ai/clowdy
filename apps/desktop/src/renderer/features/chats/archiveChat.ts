import { ancestorChats, chatOfRun } from '../agents/agentTree';
import { perform } from './commands';

import type { Chat, ChatId, RunId } from '@clowdy/protocol';
import type { ProjectState, ProjectUi, RootStore } from '../../stores';

/**
 * Puts the chat in the archive and tells the person when the daemon refused (its agents are working). The daemon puts the chat's threads away with it.
 * The chat that is open goes out of sight with it, so the page moves on to the first chat that is still listed.
 */
export async function archiveChat(root: RootStore, ui: ProjectUi, chat: Chat, isOpen: boolean): Promise<void> {
    const result = await perform(root, { type: 'chat.setArchived', chatId: chat.id, archived: true });

    if (result.ok && isOpen) ui.openChat(null);
}

/** Brings the chat out of the archive, into the list: only the chat itself, its threads stay put away. False when the daemon refused (the person has been told). */
export async function unarchiveChat(root: RootStore, chat: Chat): Promise<boolean> {
    return (await perform(root, { type: 'chat.setArchived', chatId: chat.id, archived: false })).ok;
}

/**
 * Brings back what the chat needs to be listed: the chats above it that are in the archive, the farthest first, then the chat itself. A thread is a row
 * under its parent, so a thread of an archived chat comes back with the path to it. False when the daemon refused one.
 */
async function bringBack(root: RootStore, project: ProjectState, chat: Chat): Promise<boolean> {
    const path = [...ancestorChats(project.chats, chat.id).reverse(), chat].filter(candidate => candidate.archivedAt !== undefined);

    for (const archived of path) {
        if (!(await unarchiveChat(root, archived))) return false;
    }

    return true;
}

/**
 * Shows the chat in the Agents section. A chat in the archive has no row and no page, so a link to one (a chip, a task's chat, a thread's card) brings
 * it back first, as picking it in the archive's list does, and with it the archived chats above it.
 */
export async function openChat(root: RootStore, project: ProjectState, ui: ProjectUi, chatId: ChatId): Promise<void> {
    const chat = project.chats.get(chatId);

    if (chat && !(await bringBack(root, project, chat))) return;

    ui.openChat(chatId);
}

/** Shows the run below its chat in the Agents section, bringing the chat (and the archived chats above it) out of the archive first. */
export async function openRun(root: RootStore, project: ProjectState, ui: ProjectUi, runId: RunId): Promise<void> {
    const run = project.runs.get(runId);
    const owner = run ? chatOfRun(project.chats.values(), run) : undefined;

    if (owner && !(await bringBack(root, project, owner))) return;

    ui.openRun(runId);
}
