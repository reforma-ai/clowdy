import { createContext } from 'react';

import type { Attachment, Chat, ChatId, EngineId, SkillEntry, Task, TaskId } from '@clowdy/protocol';

/** What a message's text may point at inside the app. Without it, task keys and chat references stay plain text and a thread's name opens nothing. */
export interface StreamLinks {
    /** The task a key like `CAR-24` names, when the project has one. It answers at once, and a key the window does not know yet may be read from the daemon meanwhile (`ProjectState.taskOfKey`): call it while rendering, so the chip appears when the task is known. */
    taskOfKey?: (key: string) => Pick<Task, 'id' | 'key' | 'title'> | undefined;
    /** The skill a name like `review` names, when the person has it (the system ones are not theirs to ask for). Without it, `/review` and `$review` in a message stay plain text. */
    skillOfName?: (name: string) => Pick<SkillEntry, 'name' | 'description'> | undefined;
    onOpenTask?: (taskId: TaskId) => void;
    /** The bytes of a file a message carries, to show an image. Without it a file shows as its icon. */
    attachmentBlob?: (attachment: Attachment) => Promise<Blob>;
    /** Whether the project still has the chat a thread's card names: a deleted one is plain text. */
    hasChat?: (chatId: ChatId) => boolean;
    /** The current title of a chat named by a message reference. */
    chatOfId?: (chatId: ChatId) => Pick<Chat, 'id' | 'title'> | undefined;
    /** The agent a chat runs on, for the mark of a card that names the chat as its writer. Without it, or for a chat the project no longer has, the card has no agent's mark. */
    engineOfChat?: (chatId: ChatId) => EngineId | undefined;
    /** Opens a referenced chat or a chat a thread's card names (the thread that wrote, or the one that stopped). */
    onOpenChat?: (chatId: ChatId) => void;
}

/** The default, one object for every stream without links: a fresh one per render would re-render everything that reads the context. */
export const NO_LINKS: StreamLinks = {};

export const StreamLinksContext = createContext<StreamLinks>(NO_LINKS);
