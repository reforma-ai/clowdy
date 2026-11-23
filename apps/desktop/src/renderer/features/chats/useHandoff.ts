import { useEffect, useRef } from 'react';

import { useProjectUi, useRootStore } from '../../stores';
import { startHandoff } from './handoff';

import type { Chat, Run } from '@clowdy/protocol';

/**
 * Hand-off for a chat's answers: `handOff(itemId, engine)` opens the new-chat page on the agent `engine` with the conversation up to that answer attached
 * (`startHandoff`). A person who has left the chat before the conversation was ready is not taken to the page.
 */
export function useHandoff(chat: Chat, run: Run | undefined) {
    const root = useRootStore();
    const ui = useProjectUi();
    const shown = useRef(false);

    useEffect(() => {
        shown.current = true;

        return () => {
            shown.current = false;
        };
    }, []);

    return (itemId: string, engine: string) => {
        void startHandoff({ root, ui, chat, run, itemId, engine, stillOpen: () => shown.current });
    };
}
