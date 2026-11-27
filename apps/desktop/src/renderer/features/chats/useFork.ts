import { useCallback, useEffect, useRef, useState } from 'react';

import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { forkChat } from './forkChat';

import type { Chat } from '@clowdy/protocol';

/**
 * Fork for a chat's messages: `fork(itemId)` makes the new chat at that answer and opens it. One fork at a time: `forking` is the answer a fork is being
 * made at, whose button spins while the others wait, and a press meanwhile does nothing. A person who has left the chat before the new one is ready
 * is not taken to it.
 */
export function useFork(chat: Chat) {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const [forking, setForking] = useState<string>();
    // A press in the same frame as another is turned away before the state it sets has drawn.
    const busy = useRef(false);
    const shown = useRef(false);

    useEffect(() => {
        shown.current = true;

        return () => {
            shown.current = false;
        };
    }, []);

    const fork = useCallback(
        async (itemId: string) => {
            if (busy.current) return;

            busy.current = true;
            setForking(itemId);

            try {
                await forkChat({ root, project, ui, chatId: chat.id, itemId, stillOpen: () => shown.current });
            } finally {
                busy.current = false;
                setForking(undefined);
            }
        },
        [root, project, ui, chat.id]
    );

    return { fork, forking };
}
