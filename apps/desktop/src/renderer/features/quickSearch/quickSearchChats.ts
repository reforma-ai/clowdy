import { chatFolder } from '../agents/agentTree';

import type { Chat } from '@clowdy/protocol';
import type { ProjectState } from '../../stores';
import type { FoundChat } from './QuickSearchModel';

/** What of a project the search of chats reads. */
export type ChatsOfProject = Pick<ProjectState, 'chats' | 'runs'> & { project: Pick<ProjectState['project'], 'folders'> };

/**
 * The chats of a project that answer the words typed: every word is in the title, ignoring case. The ones whose title starts with the first word come first, then the
 * rest, and in each the latest first; the chats in the archive after those in use, since opening one brings it back but the person is mostly looking for the others.
 * Threads are found like any chat. With nothing typed it is the latest chats the person made, in use: a thread of an agent is not what they come back to.
 */
export function foundChats({ chats, runs, project }: ChatsOfProject, query: string): FoundChat[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const first = words[0];
    const several = project.folders.length > 1;
    const scoreOf = ({ title }: Chat) => (first === undefined ? 0 : title.toLowerCase().startsWith(first) ? 0 : 1);

    return [...chats.values()]
        .filter((chat) => {
            if (first === undefined) return chat.archivedAt === undefined && chat.parentChatId === undefined;

            const title = chat.title.toLowerCase();

            return words.every(word => title.includes(word));
        })
        .sort((a, b) => Number(a.archivedAt !== undefined) - Number(b.archivedAt !== undefined) || scoreOf(a) - scoreOf(b) || b.updatedAt - a.updatedAt)
        .map((chat): FoundChat => ({
            kind: 'chat',
            id: `chat:${ chat.id }`,
            chatId: chat.id,
            chat,
            run: chat.orchestratorRunId === undefined ? undefined : runs.get(chat.orchestratorRunId),
            note: chat.archivedAt === undefined ? (several ? chatFolder(chats, project.folders, chat.id)?.name : undefined) : 'Archived',
        }));
}
