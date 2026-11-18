import { createContext } from 'react';

import type { Task, TaskId } from '@clowdy/protocol';

/** What a message's text may point at inside the app. Without it, task keys stay plain text. */
export interface StreamLinks {
    /** The task a key like `CAR-24` names, when the project has one. */
    taskOfKey?: (key: string) => Pick<Task, 'id' | 'key' | 'title'> | undefined;
    onOpenTask?: (taskId: TaskId) => void;
}

/** The default, one object for every stream without links: a fresh one per render would re-render everything that reads the context. */
export const NO_LINKS: StreamLinks = {};

export const StreamLinksContext = createContext<StreamLinks>(NO_LINKS);
