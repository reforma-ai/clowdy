import { findNext, findPrevious, openSearchPanel } from '@codemirror/search';
import { EditorView } from '@codemirror/view';

export type EditorSearchCommand = 'open' | 'next' | 'previous';

/**
 * Runs a search command of the code editor that `from` is in (the focused element by default): the editor's own search panel opens, or goes to its next
 * or previous match. Resolves `false` when `from` is not in a code editor, so a host that has a find of its own for the page (the desktop app's `Cmd+F`)
 * can leave the key to the editor where there is one and keep it everywhere else. It imports only the editor, so a host can call it without loading the file manager.
 */
export function searchInEditor(command: EditorSearchCommand, from: Element | null = document.activeElement): boolean {
    const editor = from?.closest<HTMLElement>('.cm-editor');
    const view = editor ? EditorView.findFromDOM(editor) : null;

    if (!view) {
        return false;
    }

    if (command === 'open') {
        return openSearchPanel(view);
    }

    return command === 'next' ? findNext(view) : findPrevious(view);
}
