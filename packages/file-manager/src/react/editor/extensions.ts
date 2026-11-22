import { codeHighlighter } from '@clowdy/components/codeLanguages';
import { ChevronDown, ChevronRight } from '@clowdy/icons/8';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
    bracketMatching,
    foldGutter,
    foldKeymap,
    indentOnInput,
    indentUnit,
    syntaxHighlighting,
} from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import {
    crosshairCursor,
    drawSelection,
    dropCursor,
    highlightActiveLine,
    highlightActiveLineGutter,
    highlightSpecialChars,
    keymap,
    lineNumbers,
    rectangularSelection,
} from '@codemirror/view';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import type { Extension } from '@codemirror/state';
import type { ComponentType } from 'react';

/** A kit icon rendered once to plain DOM, for markers CodeMirror draws outside React. */
function iconTemplate(Icon: ComponentType): Element {
    const host = document.createElement('span');
    const root = createRoot(host);

    flushSync(() => root.render(createElement(Icon)));

    const icon = host.firstElementChild!.cloneNode(true) as Element;

    root.unmount();

    return icon;
}

// At import: markers first appear inside a React effect, where flushSync cannot render.
const foldChevrons = { open: iconTemplate(ChevronDown), closed: iconTemplate(ChevronRight) };

/** The tree's chevrons instead of CodeMirror's text arrows. */
function foldMarker(open: boolean): HTMLElement {
    const marker = document.createElement('span');

    marker.title = open ? 'Fold line' : 'Unfold line';
    marker.append((open ? foldChevrons.open : foldChevrons.closed).cloneNode(true));

    return marker;
}

/** What every text document gets while a view shows it: editing, folding, search, keys and colors. */
export const baseExtensions: Extension = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter({ markerDOM: foldMarker }),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    EditorState.tabSize.of(2),
    indentUnit.of('  '),
    indentOnInput(),
    syntaxHighlighting(codeHighlighter),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        indentWithTab,
    ]),
];
