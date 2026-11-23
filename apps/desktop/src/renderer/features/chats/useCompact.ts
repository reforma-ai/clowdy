import { useState } from 'react';

import { useRootStore } from '../../stores';
import { perform } from './commands';

/**
 * Compact for a chat: sends `chat.compact`, pending while the daemon has it. The daemon runs it now, or queues it while the orchestrator works; a
 * refusal is the usual toast.
 */
export function useCompact(chatId: string) {
    const root = useRootStore();
    const [isPending, setIsPending] = useState(false);

    const compact = async () => {
        setIsPending(true);

        try {
            return await perform(root, { type: 'chat.compact', chatId });
        } finally {
            setIsPending(false);
        }
    };

    return { compact, isPending };
}
