import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';

import type { ClipboardFile } from '../../../shared/bridge';

/**
 * The door from the rest of the window to the message box. `Composer` is a component and the side panel (Files, Changes) must not import it, so the box
 * that is on the page registers what it takes here while it is mounted, so the panel can add quotes and file references. A module-level
 * registry beside the drafts, as `composerQuotes` and `filesStoreOf` are. The box of the open chat (`ChatView`) and the new-chat page's (`DraftChat`) register;
 * the box of an edit frame does not, and a chat that is read only has no box, so it registers nothing. The last box registered is the one asked.
 */
type Quote = (text: string) => void;
type MentionFiles = (files: readonly ClipboardFile[]) => boolean;
interface ComposerBridge {
    quote: Quote;
    mentionFiles?: MentionFiles;
    appendText?: (text: string) => boolean;
}

const composers: ComposerBridge[] = [];
const listeners = new Set<() => void>();

const changed = () => listeners.forEach(listener => listener());

function subscribe(listener: () => void): () => void {
    listeners.add(listener);

    return () => void listeners.delete(listener);
}

/** A message box that takes quotes and optionally file references, until the returned function is called. */
export function registerComposer(
    quote: Quote,
    mentionFiles?: MentionFiles,
    appendText?: (text: string) => boolean
): () => void {
    const composer = { quote, mentionFiles, appendText };
    composers.push(composer);
    changed();

    return () => {
        const index = composers.lastIndexOf(composer);

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
    const quote = composers.at(-1)?.quote;

    if (!quote) return false;

    quote(text);

    return true;
}

/** Adds a plain paragraph to the current draft without replacing it. */
export function appendTextIntoComposer(text: string): boolean {
    return composers.at(-1)?.appendText?.(text) ?? false;
}

/** Whether a message box is mounted to take a quote: what decides if the side panel offers Add to chat at all. */
export function useHasComposer(): boolean {
    return useSyncExternalStore(subscribe, () => composers.length > 0);
}

/** Adds references to files in the current chat's place without uploading their contents. */
export function mentionFilesIntoComposer(files: readonly ClipboardFile[]): boolean {
    return composers.at(-1)?.mentionFiles?.(files) ?? false;
}

export function useCanMentionFiles(): boolean {
    return useSyncExternalStore(subscribe, () => composers.at(-1)?.mentionFiles !== undefined);
}

/**
 * Registers the message box while it is mounted, except the box of an edit frame. The bridge calls the latest callbacks through a ref.
 */
export function useRegisterComposer(
    quote: Quote | undefined,
    mentionFiles?: MentionFiles,
    appendText?: (text: string) => boolean
): void {
    const latest = useRef({ quote, mentionFiles, appendText });
    const takes = quote !== undefined;
    const takesFiles = mentionFiles !== undefined;
    const takesText = appendText !== undefined;

    useLayoutEffect(() => {
        latest.current = { quote, mentionFiles, appendText };
    });

    useEffect(
        () =>
            takes
                ? registerComposer(
                      text => latest.current.quote?.(text),
                      takesFiles ? files => latest.current.mentionFiles?.(files) ?? false : undefined,
                      takesText ? text => latest.current.appendText?.(text) ?? false : undefined
                  )
                : undefined,
        [takes, takesFiles, takesText]
    );
}
