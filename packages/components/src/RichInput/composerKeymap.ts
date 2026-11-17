import { chainCommands, liftEmptyBlock, splitBlock } from '@tiptap/pm/commands';
import { splitListItem } from '@tiptap/pm/schema-list';

import type { EditorView } from '@tiptap/pm/view';

export type ComposerKeyDownOptions = {
    submitOnEnter: boolean;
    hasMenuItems: boolean;
    onSubmit?: (origin: { mod: boolean }) => void;
    onEscape?: () => void;
    closeMenu?: () => void;
};

function selectionInList(state: {
    selection: { $from: { depth: number; node: (depth: number) => { type: { name: string } } } };
}): boolean {
    const { $from } = state.selection;

    for (let depth = $from.depth; depth > 0; depth--) {
        if ($from.node(depth).type.name === 'listItem') {
            return true;
        }
    }

    return false;
}

export function handleComposerKeyDown(
    view: EditorView,
    event: KeyboardEvent,
    options: ComposerKeyDownOptions
): boolean {
    if (event.key === 'Escape') {
        if (options.hasMenuItems) {
            options.closeMenu?.();

            return true;
        }

        options.onEscape?.();

        return false;
    }

    if (event.key !== 'Enter' || event.isComposing) {
        return false;
    }

    if (options.hasMenuItems) {
        return false;
    }

    const mod = event.metaKey || event.ctrlKey;
    const inList = selectionInList(view.state);

    if (options.submitOnEnter && !event.shiftKey && !mod) {
        if (inList) {
            return false;
        }

        event.preventDefault();
        options.onSubmit?.({ mod: false });

        return true;
    }

    if (mod && !event.shiftKey && !event.altKey && options.onSubmit) {
        event.preventDefault();
        options.onSubmit({ mod: true });

        return true;
    }

    // Shift+Enter: next list item, or lift an empty bullet. Plain Enter stays on listItem.
    if (inList) {
        if (event.shiftKey) {
            const listItem = view.state.schema.nodes.listItem;

            if (listItem && chainCommands(splitListItem(listItem), liftEmptyBlock)(view.state, view.dispatch)) {
                event.preventDefault();

                return true;
            }
        }

        return false;
    }

    // New paragraph so markdown input rules (`- `, `1. `) work at the start of every line.
    event.preventDefault();

    return splitBlock(view.state, view.dispatch);
}
