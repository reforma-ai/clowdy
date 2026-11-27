import { useSyncExternalStore } from 'react';

const sending = new Set<string>();
const listeners = new Set<() => void>();

export function isDraftSending(key: string): boolean {
    return sending.has(key);
}

export function setDraftSending(key: string, value: boolean): void {
    if (value) sending.add(key);
    else sending.delete(key);
    for (const listener of listeners) listener();
}

export function useDraftSending(key: string | undefined): boolean {
    return useSyncExternalStore(
        listener => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        () => key !== undefined && sending.has(key)
    );
}
