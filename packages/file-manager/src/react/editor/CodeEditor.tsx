import { codeLanguage } from '@clowdy/components/codeLanguages';
import {
    elementScrollAxisSource,
    ScrollChromeBars,
    ScrollChromeRoot,
    useScrollChrome,
} from '@clowdy/components/Scrollable';
import { EditorView } from '@codemirror/view';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { basename, extname } from '../../paths';
import styles from './CodeEditor.module.css';
import { baseExtensions } from './extensions';

import type { EditorState, Extension, StateEffect } from '@codemirror/state';
import type { TextDocument } from '../../documents/TextDocument';

/** Where each document was scrolled, kept across tab switches and remounts. */
const scrollSnapshots = new WeakMap<TextDocument, { effect: StateEffect<unknown>; state: EditorState }>();

function hide(view: EditorView, document: TextDocument): void {
    scrollSnapshots.set(document, { effect: view.scrollSnapshot(), state: view.state });
    document.detach(view);
}

/** Restores the scroll position, unless the selection moved while hidden (e.g. `open` at a line); then centers it. */
function restoreScroll(view: EditorView, document: TextDocument): void {
    const snapshot = scrollSnapshots.get(document);
    const { state } = view;

    view.dispatch({
        effects:
            snapshot && snapshot.state.doc === state.doc && snapshot.state.selection.eq(state.selection)
                ? snapshot.effect
                : EditorView.scrollIntoView(state.selection.main, { y: 'center' }),
    });
}

interface CodeEditorProps {
    /** The document to show; `null` keeps the editor hidden with its last state. */
    document: TextDocument | null;
    /** Host extensions added to every document while it is shown. */
    extensions?: Extension;
}

/** One CodeMirror view that shows each document by swapping in its `EditorState`. */
export const CodeEditor = observer(function CodeEditor({ document, extensions }: CodeEditorProps) {
    const [view, setView] = useState<EditorView | null>(null);
    const shown = useRef<TextDocument | null>(null);

    const mount = useCallback((host: HTMLDivElement | null) => {
        if (!host) {
            return;
        }

        const editor = new EditorView({
            parent: host,
            dispatchTransactions(transactions, target) {
                target.update(transactions);
                shown.current?.setState(target.state);
            },
        });

        setView(editor);

        return () => {
            if (shown.current) {
                hide(editor, shown.current);
                shown.current = null;
            }

            editor.destroy();
        };
    }, []);

    // A rename can change the language, so the document is shown again for a new path.
    const path = document?.path;

    useEffect(() => {
        if (!view || !document?.state) {
            return;
        }

        let current = true;
        const configure = (language: Extension) => {
            document.configure([
                baseExtensions,
                language,
                EditorView.contentAttributes.of({ 'aria-label': basename(document.path) }),
                extensions ?? [],
            ]);
        };
        const language = codeLanguage(extname(document.path));

        configure(language instanceof Promise ? [] : (language ?? []));
        view.setState(document.state!);
        shown.current = document;
        document.attach(view);
        restoreScroll(view, document);

        if (language instanceof Promise) {
            void language.then(loaded => {
                if (current && loaded) {
                    configure(loaded);
                }
            });
        }

        return () => {
            current = false;

            if (shown.current === document) {
                hide(view, document);
                shown.current = null;
            }
        };
    }, [view, document, path, extensions]);

    const getScrollElement = useCallback(() => view?.scrollDOM ?? null, [view]);
    const verticalSource = useMemo(() => elementScrollAxisSource(getScrollElement, 'vertical'), [getScrollElement]);
    const horizontalSource = useMemo(() => elementScrollAxisSource(getScrollElement, 'horizontal'), [getScrollElement]);
    const chrome = useScrollChrome({ verticalSource, horizontalSource, sourceKey: view });

    return (
        <ScrollChromeRoot
            rootRef={chrome.rootRef}
            className={styles.root}
            data-hidden={document ? undefined : ''}
            vertical
            horizontal
            rootPointerHandlers={chrome.rootPointerHandlers}
        >
            <div ref={mount} className={styles.editor} />
            <ScrollChromeBars
                vertical
                horizontal
                setScrollbarV={chrome.setScrollbarV}
                setScrollbarH={chrome.setScrollbarH}
                onPointerDown={chrome.handlePointerDown}
            />
        </ScrollChromeRoot>
    );
});
