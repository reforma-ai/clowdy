import { codeHighlighter, codeLanguage } from '@clowdy/components/codeLanguages';
import {
    elementScrollAxisSource,
    ScrollChromeBars,
    ScrollChromeRoot,
    useScrollChrome,
} from '@clowdy/components/Scrollable';
import { cn, scrollParent } from '@clowdy/lib';
import { defaultKeymap } from '@codemirror/commands';
import { syntaxHighlighting } from '@codemirror/language';
import { unifiedMergeView } from '@codemirror/merge';
import { Compartment, EditorState, RangeSetBuilder, Text } from '@codemirror/state';
import { Decoration, drawSelection, EditorView, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { basename, extname } from '../../paths';
import styles from './DiffView.module.css';
import { estimateDiffLines } from './estimateDiffLines';

import type { LanguageSupport } from '@codemirror/language';
import type { Extension } from '@codemirror/state';

/** Lines of context kept around a change, and the fewest unchanged lines worth folding into one row. */
const COLLAPSE_MARGIN = 3;
const COLLAPSE_MIN_LINES = 5;

/** How far outside the viewport a lazy view starts to mount its editor, so it is drawn by the time it scrolls in. */
const MOUNT_MARGIN = '800px 0px';

/**
 * The longest the diff of one file may take. The merge package's own limit (a scan depth of 500) is meant for a text being typed in
 * and gives up on an ordinary change: a file of 1000 lines with 25 edited ones comes out as one chunk, every line removed and added.
 * With no depth limit the diff is exact and fast until the texts have little in common, and the time cuts that case short.
 */
const DIFF_TIMEOUT_MS = 200;

/** The host's extensions live in a compartment, so a new set replaces the old one without building the state again. */
const hostExtensions = new Compartment();

export interface DiffViewProps {
    /** The file's path: its extension picks the language and its name labels the text for screen readers. */
    path: string;
    /** The text before the change; `null` for a file that is not there yet, so everything shows as added. */
    original: string | null;
    /** The text after the change; `null` for a file that is gone, so everything shows as removed. */
    modified: string | null;
    /** Host extensions (a selection button, say), added to the editor and swapped without losing the selection. */
    extensions?: Extension;
    /** Build the editor only once the view is near the viewport; until then a box of the estimated height stands in. */
    lazy?: boolean;
    /** The lines the box should hold before the editor is built; the guess from the two texts when not given. */
    estimatedLines?: number;
    className?: string;
}

/** The language of the path's extension: `undefined` while it loads or while the view is not wanted, `null` for plain text. */
function useCodeLanguage(path: string, enabled: boolean): LanguageSupport | null | undefined {
    const result = enabled ? codeLanguage(extname(path)) : undefined;
    // The language the editor has now: a path that changes to a language still loading keeps it, instead of tearing the editor down.
    const [current, setCurrent] = useState<LanguageSupport | null | undefined>(undefined);
    const settled = result instanceof Promise ? undefined : result;

    if (settled !== undefined && settled !== current) {
        setCurrent(settled);
    }

    useEffect(() => {
        if (!(result instanceof Promise)) {
            return;
        }

        let live = true;

        void result.then((support) => {
            if (live) {
                setCurrent(support);
            }
        });

        return () => {
            live = false;
        };
    }, [result]);

    return result instanceof Promise ? current : result;
}

/**
 * What the observer measures against: the scroll container the view is in, or the viewport when there is none. A margin reaches past
 * the edge of a scroll container only when that container is the observer's root; with the viewport as root, a view below the fold of
 * its container counts as far away however big the margin.
 */
function observerRoot(element: HTMLElement): Element | null {
    const container = scrollParent(element);
    const { documentElement, scrollingElement } = element.ownerDocument;

    return container === documentElement || container === scrollingElement ? null : container;
}

/** True once a lazy view has come near the viewport, and for good: it is never unmounted again, so the list does not jump. */
function useNearViewport(lazy: boolean, rootRef: { current: HTMLElement | null }): boolean {
    const [near, setNear] = useState(false);
    const observable = typeof IntersectionObserver !== 'undefined';
    const waiting = lazy && observable && !near;

    useEffect(() => {
        const root = rootRef.current;

        if (!waiting || !root) {
            return;
        }

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some(entry => entry.isIntersecting)) {
                    setNear(true);
                }
            },
            { root: observerRoot(root), rootMargin: MOUNT_MARGIN }
        );

        observer.observe(root);

        return () => observer.disconnect();
    }, [waiting, rootRef]);

    return !waiting;
}

const addedLine = Decoration.line({ class: 'cm-changedLine' });

/**
 * Every line of the document marked as added, as the merge extension marks a changed one. The extension is not used for a file with no
 * earlier text: it would show the empty text as one removed blank line above the new ones.
 */
const allAdded = EditorView.decorations.compute(['doc'], (state) => {
    const { doc } = state;

    if (!doc.length) {
        return Decoration.none;
    }

    // The last line is empty when the text ends with a line break: that is no line of the file.
    const last = doc.lines > 1 && doc.line(doc.lines).length === 0 ? doc.lines - 1 : doc.lines;
    const builder = new RangeSetBuilder<Decoration>();

    for (let number = 1; number <= last; number++) {
        const { from } = doc.line(number);

        builder.add(from, from, addedLine);
    }

    return builder.finish();
});

function createState(
    { path, original, modified }: Pick<DiffViewProps, 'path' | 'original' | 'modified'>,
    language: LanguageSupport | null,
    host: Extension
): EditorState {
    const text = modified ?? '';

    return EditorState.create({
        doc: text,
        extensions: [
            // A file that is gone has no lines of its own to number: its one empty line would be a lone "1" under the removed ones.
            text ? lineNumbers() : [],
            highlightSpecialChars(),
            drawSelection(),
            EditorState.readOnly.of(true),
            EditorState.tabSize.of(2),
            syntaxHighlighting(codeHighlighter),
            // Selecting all and moving the caret; every command that edits stands down in a read-only state.
            keymap.of(defaultKeymap),
            EditorView.contentAttributes.of({ 'aria-label': `Changes in ${ basename(path) }` }),
            language ?? [],
            original
                ? unifiedMergeView({
                    // Cut at the line breaks the document is cut at (a lone CR is one too), or such a text would differ from itself.
                    original: Text.of(original.split(/\r\n?|\n/)),
                    diffConfig: { timeout: DIFF_TIMEOUT_MS },
                    mergeControls: false,
                    // No stripe in the gutter: the lines carry their own edge (see the styles).
                    gutter: false,
                    // A file that is gone is removed as a whole: marking every word of it would only add noise.
                    highlightChanges: Boolean(text),
                    collapseUnchanged: { margin: COLLAPSE_MARGIN, minSize: COLLAPSE_MIN_LINES },
                })
                : allAdded,
            hostExtensions.of(host),
        ],
    });
}

/**
 * A read-only unified diff of two texts of one file: changed lines tinted, removed lines above the ones that replace them, unchanged
 * stretches folded. It is built on `@codemirror/merge`, with the editor's look and the language of `path`.
 */
export function DiffView({ path, original, modified, extensions, lazy = false, estimatedLines, className }: DiffViewProps) {
    const [view, setView] = useState<EditorView | null>(null);
    const hostRef = useRef<Extension>([]);

    const getScrollElement = useCallback(() => view?.scrollDOM ?? null, [view]);
    const horizontalSource = useMemo(() => elementScrollAxisSource(getScrollElement, 'horizontal'), [getScrollElement]);
    const chrome = useScrollChrome({ horizontalSource, sourceKey: view });

    const wanted = useNearViewport(lazy, chrome.rootRef);
    const language = useCodeLanguage(path, wanted);
    const ready = wanted && language !== undefined;
    const boxLines = useMemo(() => estimatedLines ?? estimateDiffLines(original, modified), [estimatedLines, original, modified]);

    const mount = useCallback((host: HTMLDivElement | null) => {
        if (!host) {
            return;
        }

        const editor = new EditorView({ parent: host });

        setView(editor);

        return () => {
            editor.destroy();
            setView(null);
        };
    }, []);

    // Before paint, so the box that stood in is not swapped for an empty editor for a frame.
    useLayoutEffect(() => {
        if (view && language !== undefined) {
            view.setState(createState({ path, original, modified }, language, hostRef.current));
        }
    }, [view, path, original, modified, language]);

    // After the state, so the first set of extensions lands on the state that was just built.
    useLayoutEffect(() => {
        hostRef.current = extensions ?? [];

        if (view && hostExtensions.get(view.state) !== undefined) {
            view.dispatch({ effects: hostExtensions.reconfigure(hostRef.current) });
        }
    }, [view, extensions]);

    return (
        <ScrollChromeRoot
            rootRef={ chrome.rootRef }
            className={ cn(styles.root, className) }
            data-state={ view ? 'ready' : 'idle' }
            // Until the editor stands, a box of about the height it will take keeps the cards below from jumping.
            style={ view ? undefined : { minHeight: `calc(${ boxLines } * var(--leading-md) + var(--spacing-16))` } }
            vertical={ false }
            horizontal
            rootPointerHandlers={ chrome.rootPointerHandlers }
        >
            { ready ? <div ref={ mount } className={ styles.content } /> : null }
            <ScrollChromeBars
                vertical={ false }
                horizontal
                setScrollbarH={ chrome.setScrollbarH }
                onPointerDown={ chrome.handlePointerDown }
            />
        </ScrollChromeRoot>
    );
}
