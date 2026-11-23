import { selectionAction } from '@clowdy/file-manager/react';
import { useLayoutEffect, useMemo, useRef } from 'react';

import { useProjectUi } from '../../stores';
import { codeQuote } from './codeQuote';
import { quoteIntoComposer, useHasComposer } from './composerBridge';

/** What `selectionAction` makes: a CodeMirror extension (the app has no CodeMirror of its own, only the file manager's). */
type EditorExtension = ReturnType<typeof selectionAction>;

/**
 * Add to chat for the code the side panel shows (the Files editor, the diff cards): the editor extension that offers a button and `Mod-i` over selected words, or
 * `undefined` while no message box is mounted to take them, so nothing is offered and the editor keeps its own `Mod-i`. A press quotes the words into the box
 * (`codeQuote` over `quoteIntoComposer`), which takes the focus; a panel that covers the chat is shut then (`ProjectUi.showChat`), since a box that is out of sight cannot be
 * typed in. `pathOf` says which file the words are of when they are quoted (the Files tab's open file changes under the same editor). The extension is made once for
 * as long as a box is there: a new one would reconfigure the editor.
 */
export function useAddToChat(pathOf: () => string | undefined): EditorExtension | undefined {
    const ui = useProjectUi();
    const hasComposer = useHasComposer();
    const latest = useRef(pathOf);

    useLayoutEffect(() => {
        latest.current = pathOf;
    });

    return useMemo(() => {
        if (!hasComposer) return undefined;

        return selectionAction({
            label: 'Add to chat',
            onAction: selected => {
                const path = latest.current();

                if (path !== undefined && quoteIntoComposer(codeQuote(path, selected))) ui.showChat();
            },
        });
    }, [hasComposer, ui]);
}
