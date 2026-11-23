import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';

/**
 * The door from the rest of the window to the message box. `Composer` is a component and the side panel (Files, Changes) must not import it, so the box
 * that is on the page registers what it takes here while it is mounted, and the panel puts words into it through `quoteIntoComposer`. A module-level
 * registry beside the drafts, as `composerQuotes` and `filesStoreOf` are. The box of the open chat (`ChatView`) and the new-chat page's (`DraftChat`) register;
 * the box of an edit frame does not, and a chat that is read only has no box, so it registers nothing. The last box registered is the one asked.
 */
type Quote = (text: string) => void;

const composers: Quote[] = [];
const listeners = new Set<() => void>();

const changed = () => listeners.forEach(listener => listener());

function subscribe(listener: () => void): () => void {
    listeners.add(listener);

    return () => void listeners.delete(listener);
}

/** A message box that takes quotes, until the returned function is called (a box that unmounts calls it). */
export function registerComposer(quote: Quote): () => void {
    composers.push(quote);
    changed();

    return () => {
        const index = composers.lastIndexOf(quote);

        if (index < 0) return;

        composers.splice(index, 1);
        changed();
    };
}

/**
 * Adds `text` to the end of the draft of the message box that was registered last, as a quote, and puts the focus in that box (`ComposerHandle.quote`).
 * False when no box is mounted: nothing was added.
 */
export function quoteIntoComposer(text: string): boolean {
    const quote = composers.at(-1);

    if (!quote) return false;

    quote(text);

    return true;
}

/** Whether a message box is mounted to take a quote: what decides if the side panel offers Add to chat at all. */
export function useHasComposer(): boolean {
    return useSyncExternalStore(subscribe, () => composers.length > 0);
}

/**
 * Registers a message box's quote while it is mounted, unless it is `undefined` (the box of an edit frame). The box's `quote` is a new function each render, so the door
 * calls the latest one through a ref and the registration is made once.
 */
export function useRegisterComposer(quote: Quote | undefined): void {
    const latest = useRef(quote);
    const takes = quote !== undefined;

    useLayoutEffect(() => {
        latest.current = quote;
    });

    useEffect(() => (takes ? registerComposer(text => latest.current?.(text)) : undefined), [takes]);
}
