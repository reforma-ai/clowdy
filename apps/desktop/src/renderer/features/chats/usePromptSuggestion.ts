import { useEffect, useRef, useState } from 'react';

import type { Run } from '@clowdy/protocol';
import type { Transport } from '../../daemon/transport';

/** Fetch only a completion observed by this composer, never an old turn on returning to a chat. */
export function usePromptSuggestion(transport: Transport, run: Run | undefined, eligible: boolean) {
    const [prediction, setPrediction] = useState<{ id: string; finishedAt: number; text: string }>();
    const previous = useRef<{ id?: string; finishedAt?: number }>({});
    const dismissed = useRef<{ id?: string; finishedAt?: number }>({});
    const id = run?.id;
    const finishedAt = run?.status === 'succeeded' ? run.finishedAt : undefined;

    const dismiss = () => {
        if (!id || finishedAt === undefined) return;
        dismissed.current = { id, finishedAt };
        // An asynchronous send from another chat may still give its draft back after we switch.
        setPrediction(value => (value?.id === id && value.finishedAt === finishedAt ? undefined : value));
    };

    useEffect(() => {
        const isDismissed = () => dismissed.current.id === id && dismissed.current.finishedAt === finishedAt;
        const before = previous.current;
        previous.current = { id, finishedAt };
        setPrediction(undefined);

        if (
            !eligible ||
            !id ||
            finishedAt === undefined ||
            before.id !== id ||
            before.finishedAt !== undefined ||
            isDismissed()
        ) {
            return;
        }

        let current = true;
        void transport.getPromptSuggestion(id).then(
            value => {
                if (current && !isDismissed() && value?.finishedAt === finishedAt) setPrediction({ id, ...value });
            },
            () => undefined
        );
        return () => {
            current = false;
        };
    }, [transport, id, finishedAt, eligible]);

    const suggestion =
        eligible && prediction?.id === id && prediction?.finishedAt === finishedAt ? prediction?.text : undefined;

    return { suggestion, dismiss };
}
