import { createContext } from 'react';

import type { Attachment, ChatId, Task, TaskId } from '@clowdy/protocol';

/** What a message's text may point at inside the app. Without it, task keys stay plain text and a thread's name opens nothing. */
export interface StreamLinks {
    /** The task a key like `CAR-24` names, when the project has one. */
    taskOfKey?: (key: string) => Pick<Task, 'id' | 'key' | 'title'> | undefined;
    onOpenTask?: (taskId: TaskId) => void;
    /** The bytes of a file a message carries, to show an image. Without it a file shows as its icon. */
    attachmentBlob?: (attachment: Attachment) => Promise<Blob>;
    /** Whether the project still has the chat a thread's card names: a deleted one is plain text. */
    hasChat?: (chatId: ChatId) => boolean;
    /** Opens a chat a thread's card names (the thread that wrote, or the one that stopped). */
    onOpenChat?: (chatId: ChatId) => void;
}

/** The default, one object for every stream without links: a fresh one per render would re-render everything that reads the context. */
export const NO_LINKS: StreamLinks = {};

export const StreamLinksContext = createContext<StreamLinks>(NO_LINKS);
