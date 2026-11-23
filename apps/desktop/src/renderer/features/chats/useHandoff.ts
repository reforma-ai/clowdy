import { useEffect, useRef } from 'react';

import { useProjectUi, useRootStore } from '../../stores';
import { startHandoff } from './handoff';

import type { Chat, Run } from '@clowdy/protocol';

/**
 * Hand-off for a chat: `handOff()` carries the whole conversation to the new-chat page (the read-only notice), `handOff({ itemId, engine })` the conversation up to an
 * answer, on the agent `engine` (an answer's Fork menu). Resolves to whether the page was opened (`startHandoff`). A person who has left the chat before the conversation
 * was ready is not taken to the page.
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

    return (at?: { itemId: string; engine: string }) => startHandoff({ root, ui, chat, run, stillOpen: () => shown.current, ...at });
}
