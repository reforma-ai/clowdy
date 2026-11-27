import { ancestorChats, ancestorRuns, chatOfRun } from '../agents/agentTree';
import { perform } from './commands';

import type { Chat, ChatId, Run, RunId } from '@clowdy/protocol';
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
export async function bringBack(root: RootStore, project: ProjectState, chat: Chat): Promise<boolean> {
    const path = [...ancestorChats(project.chats, chat.id).reverse(), chat].filter(
        candidate => candidate.archivedAt !== undefined
    );

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

/**
 * Puts the finished sub-agent in the archive, with the sub-agents it started, and tells the person when the daemon refused (it or one of them works). `open` is the
 * sub-agent whose page is open: when it is the one archived, or one it started, the page moves on to the chat of the sub-agent, since it has no row in the list now.
 */
export async function archiveRun(
    root: RootStore,
    project: ProjectState,
    ui: ProjectUi,
    run: Run,
    open: Run | undefined
): Promise<void> {
    const result = await perform(root, { type: 'run.setArchived', runId: run.id, archived: true });

    if (result.ok && open && (open.id === run.id || ancestorRuns(project.runs, open).some(({ id }) => id === run.id)))
        ui.openChat(chatOfRun(project.chats.values(), run)?.id ?? null);
}

/** Brings the sub-agent out of the archive, into the list: only the sub-agent itself, what it started stays put away. False when the daemon refused (the person has been told). */
async function unarchiveRun(root: RootStore, run: Run): Promise<boolean> {
    return (await perform(root, { type: 'run.setArchived', runId: run.id, archived: false })).ok;
}

/** Brings back the sub-agents above a sub-agent that are in the archive, the farthest first, then the sub-agent itself. False when the daemon refused one. */
async function bringBackRun(root: RootStore, project: ProjectState, run: Run): Promise<boolean> {
    const path = [...ancestorRuns(project.runs, run).reverse(), run].filter(
        candidate => candidate.archivedAt !== undefined
    );

    for (const archived of path) {
        if (!(await unarchiveRun(root, archived))) return false;
    }

    return true;
}

/**
 * Shows the run below its chat in the Agents section, bringing the chat (and the archived chats above it) out of the archive first, and a sub-agent in the
 * archive with the archived sub-agents above it: it has no row until then, and the card in its parent's stream, a breadcrumb or a task's link are how it is found.
 */
export async function openRun(root: RootStore, project: ProjectState, ui: ProjectUi, runId: RunId): Promise<void> {
    const run = project.runs.get(runId);
    const owner = run ? chatOfRun(project.chats.values(), run) : undefined;

    if (owner && !(await bringBack(root, project, owner))) return;

    if (run && !(await bringBackRun(root, project, run))) return;

    ui.openRun(runId);
}
