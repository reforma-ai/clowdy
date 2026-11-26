import { useMemo } from 'react';

import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { openChat } from './archiveChat';
import { chatProvider } from './chatProvider';
import { useSkillLookup } from './useSkillLookup';

import type { Attachment } from '@clowdy/protocol';
import type { StreamLinks } from '../../stream/StreamLinks';

/** The links of a conversation: every one is there, since the page that holds them opens chats and reads files itself. */
export type ConversationLinks = StreamLinks & Required<Pick<StreamLinks, 'attachmentBlob' | 'onOpenChat'>>;

/**
 * What the text of a conversation may point at in the app, the same on every page that shows one: a task key in a message is a chip that opens the task (an archived
 * one is known to the window too, `ProjectState.taskOfKey`), a skill it asks for is a chip, and a thread's card opens that thread.
 */
export function useStreamLinks(): ConversationLinks {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const skillOfName = useSkillLookup();

    return useMemo(
        (): ConversationLinks => ({
            taskOfKey: (key: string) => project.taskOfKey(key),
            skillOfName,
            onOpenTask: (taskId: string) => ui.openTask(taskId),
            attachmentBlob: (attachment: Attachment) => root.transport.getAttachment(project.id, attachment.id),
            hasChat: (chatId: string) => project.chats.has(chatId),
            chatOfId: (chatId: string) => project.chats.get(chatId),
            engineOfChat: (chatId: string) => {
                const chat = project.chats.get(chatId);

                return (
                    chat &&
                    chatProvider(chat, chat.orchestratorRunId ? project.runs.get(chat.orchestratorRunId) : undefined)
                );
            },
            onOpenChat: (chatId: string) => void openChat(root, project, ui, chatId),
        }),
        [project, ui, root, skillOfName]
    );
}
