import { Button } from '@clowdy/components/Button';
import { Hotkey } from '@clowdy/components/Hotkey';
import { Message } from '@clowdy/icons/14';
import { Prec, StateEffect, StateField } from '@codemirror/state';
import { EditorView, keymap, showTooltip } from '@codemirror/view';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';

import styles from './selectionAction.module.css';

import type { EditorState, Extension } from '@codemirror/state';
import type { Tooltip, TooltipView } from '@codemirror/view';

/** What the person selected, as the lines of the text the editor shows: 1-based, the last one included, and the words as they are written. */
export interface SelectedLines {
    from: number;
    to: number;
    text: string;
}

export interface SelectionActionOptions {
    /** The button's words and its name for a screen reader. */
    label: string;
    /**
     * What the host does with the selection. Without it the extension adds nothing, so a host that has nowhere to send the words (no chat
     * open) shows no button and leaves `Mod-i` to the editor.
     */
    onAction?: (selection: SelectedLines) => void;
}

/** A rectangle in the page's coordinates, as the editor measures a position. */
type Rect = ReturnType<NonNullable<TooltipView['getCoords']>>;

/** Where the editor is told a position is when it is not drawn: far outside any window, so the tooltip is hidden. */
const OUT_OF_SIGHT: Rect = { left: -1e5, right: -1e5, top: -1e5, bottom: -1e5 };

/** The gap kept between the button and the edge of the lines' box when the end of a long line is brought back into it. */
const EDGE_GAP = 8;

/** The key that runs the action, and the hint the button wears. `Mod` is ⌘ on a Mac and Ctrl elsewhere. */
const KEY = 'Mod-i';

/**
 * The lines the main selection covers, with the position the button stands under (the last character selected), or `undefined` when nothing is worth
 * sending: no selection, or one of blank space alone. A selection that ends at the start of a line (whole lines, a triple click or a drag down) ends on the
 * line before it, and one that starts at the end of a line (a drag from past its last character) starts on the line after it, as the lines the eye sees as selected.
 */
function readSelection(state: EditorState): { selected: SelectedLines; end: number } | undefined {
    const { doc } = state;
    const range = state.selection.main;

    if (range.empty) {
        return undefined;
    }

    const first = doc.lineAt(range.from);
    const from = range.from === first.to && range.to > range.from ? range.from + 1 : range.from;
    const end = doc.lineAt(range.to).from === range.to && range.to > from ? range.to - 1 : range.to;
    const text = doc.sliceString(from, end);

    if (!text.trim()) {
        return undefined;
    }

    return { selected: { from: doc.lineAt(from).number, to: doc.lineAt(end).number, text }, end };
}

/** The lines the selection of `state` covers and their text, or `undefined` while nothing is selected (see `selectionAction`). */
export function selectedLines(state: EditorState): SelectedLines | undefined {
    return readSelection(state)?.selected;
}

/** The primary mouse button goes down in the editor, or comes up: the selection is being dragged out, and is not final. */
const mouseHeld = StateEffect.define<boolean>();

/** The tooltip the selection of the state calls for, and whether the mouse is held down: the button waits for the mouse to be let go, as the Reply button over a message does. */
interface Offer {
    tooltip: Tooltip | null;
    held: boolean;
}

/** Hands the selection to the host and leaves nothing selected; false when there is nothing to hand over, so the key goes on to what it did before. */
function run(view: EditorView, onAction: (selection: SelectedLines) => void): boolean {
    const selected = selectedLines(view.state);

    if (!selected) {
        return false;
    }

    onAction(selected);
    view.dispatch({ selection: { anchor: view.state.selection.main.head } });

    return true;
}

/**
 * A floating button under a selection, and `Mod-i` for the same action, which hands the selected lines to the host: "Add to chat" in the Files editor and in
 * a diff card. The button is drawn in a React root of its own inside the tooltip, the app's `Button` as the Reply button over a message is, so it takes the app's
 * look; the editor gives the tooltip's box the look of its floating surfaces (`.cm-tooltip`). A press takes neither the focus nor the selection, so the
 * words are still there when it acts.
 *
 * The key is bound above the editor's own keymap (`Prec.high`): `defaultKeymap` binds `Mod-i` to select the parent syntax, and the extensions of a host come
 * after it. It runs only while there is something to send; with an empty selection the editor's own `Mod-i` still works.
 *
 * The lines are those of the document the view holds. A diff card holds the new text of its file, so what it offers is the new text's lines, not the removed ones.
 */
export function selectionAction({ label, onAction }: SelectionActionOptions): Extension {
    if (!onAction) {
        return [];
    }

    // One `create` for every selection, so the editor moves the tooltip instead of building it again.
    const create = (view: EditorView): TooltipView => {
        const dom = document.createElement('div');
        const root = createRoot(dom);

        dom.className = styles.host;
        // The press of the mouse is what moves the focus and clears the selection; the button's own press handling still sees it.
        dom.addEventListener('mousedown', event => event.preventDefault());
        root.render(createElement(
            Button,
            {
                variant: 'filling',
                size: 'sm',
                preventFocusOnPress: true,
                'aria-label': label,
                onPress: () => run(view, onAction),
            },
            createElement(Message),
            label,
            createElement(Hotkey, { hotkey: ['mod', 'i'] })
        ));

        return {
            dom,
            // Lines do not wrap, and the editor hides a tooltip whose position is outside the box the lines scroll in: the end of a long line is. The button stands
            // under the part of the line that shows instead, against the box's right edge, so it is there whatever the selection and the scroll.
            getCoords: (pos) => {
                const rect = view.coordsAtPos(pos);

                if (!rect) return OUT_OF_SIGHT;

                const box = view.scrollDOM.getBoundingClientRect();
                const left = Math.max(box.left, Math.min(rect.left, box.right - dom.getBoundingClientRect().width - EDGE_GAP));

                // The editor's rectangles are DOMRects, whose sides are not own properties a spread would copy.
                return { left, right: left, top: rect.top, bottom: rect.bottom };
            },
            // The tooltip goes while the editor updates, which may be inside a React commit, where a root cannot be unmounted.
            destroy: () => queueMicrotask(() => root.unmount()),
        };
    };
    const tooltipOf = (state: EditorState): Tooltip | null => {
        const read = readSelection(state);

        return read ? { pos: read.end, above: false, create } : null;
    };
    const offer = StateField.define<Offer>({
        create: state => ({ tooltip: tooltipOf(state), held: false }),
        update(value, transaction) {
            const held = transaction.effects.findLast(effect => effect.is(mouseHeld))?.value ?? value.held;
            const tooltip = transaction.docChanged || transaction.selection ? tooltipOf(transaction.state) : value.tooltip;

            return held === value.held && tooltip === value.tooltip ? value : { tooltip, held };
        },
        provide: field => showTooltip.from(field, ({ tooltip, held }) => (held ? null : tooltip)),
    });
    // A drag selects on and on: the button would follow the pointer and stand under it. It comes when the button is let go, wherever that is.
    const tracking = EditorView.domEventHandlers({
        mousedown(event, view) {
            if (event.button !== 0) return false;

            // After the editor's own handlers of the same event have made the selection what it ends as.
            const release = () => setTimeout(() => {
                if (view.dom.isConnected) view.dispatch({ effects: mouseHeld.of(false) });
            });

            view.dispatch({ effects: mouseHeld.of(true) });
            view.dom.ownerDocument.addEventListener('mouseup', release, { once: true, capture: true });

            return false;
        },
    });

    return [
        offer,
        tracking,
        Prec.high(keymap.of([{ key: KEY, run: view => run(view, onAction) }])),
    ];
}
