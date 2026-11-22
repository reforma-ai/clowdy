import { Button } from '@clowdy/components/Button';
import { Input } from '@clowdy/components/Input';
import { Text } from '@clowdy/components/Text';
import { searchInEditor } from '@clowdy/file-manager/editor-search';
import { ChevronDown, ChevronUp, Close } from '@clowdy/icons/14';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';

import { commandTooltip, useCommands } from '../hotkeys';
import styles from './FindBar.module.css';
import { findCommands, type FindActions } from './findCommands';

import type { FindRect, FindResult } from '../../shared/bridge';

/** `No matches` when the query is nowhere in the window, otherwise `2 of 14`. Nothing while there is nothing to report. */
function matchLabel(query: string, result: FindResult | null): string | null {
    if (query === '' || result === null) return null;

    if (result.matches === 0) return 'No matches';

    return `${ result.activeMatchOrdinal } of ${ result.matches }`;
}

/**
 * The field's value is the query, so Chromium counts it. The rect is viewport pixels, same as the input's box.
 * With no rect, the field is the last text in the shell and the last match is the one to drop.
 */
function matchInField(found: FindResult, input: HTMLInputElement | null): boolean {
    if (found.matches < 1 || found.activeMatchOrdinal < 1) return false;

    const area = found.selectionArea;
    const box = input?.getBoundingClientRect();

    if (area && area.width > 0 && area.height > 0 && box && box.width > 0 && box.height > 0) return contains(box, area);

    return found.activeMatchOrdinal === found.matches;
}

function contains(box: DOMRect, area: FindRect): boolean {
    const slop = 1;

    return area.x >= box.left - slop
        && area.y >= box.top - slop
        && area.x + area.width <= box.right + slop
        && area.y + area.height <= box.bottom + slop;
}

/** A match before the field keeps its number. One after it moves up, because the field was in between. */
function pageOrdinal(fieldOrdinal: number, nextOrdinal: number, matches: number): number {
    const ordinal = nextOrdinal > fieldOrdinal ? nextOrdinal - 1 : nextOrdinal;

    return Math.min(matches, Math.max(1, ordinal));
}

/**
 * Chromium starts a follow-up search at the caret. While the field is focused that caret sits in the query,
 * so the next step wraps to the first hit and the previous step lands on the last one. Park it until the search has run.
 */
function releaseFieldCaret(input: HTMLInputElement | null): () => void {
    if (!input || document.activeElement !== input) return () => {};

    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? 0;

    input.blur();
    window.getSelection()?.removeAllRanges();

    return () => {
        if (!input.isConnected) return;

        input.focus({ preventScroll: true });
        input.setSelectionRange(start, end);
    };
}

/**
 * Chromium's search of the text drawn in the window: a chat, a settings page, whatever is on screen, including what is scrolled out of view.
 * The query in the field is not a match. `Cmd/Ctrl+F` opens it, Enter and `Cmd/Ctrl+G` go to the next match, Shift+Enter and `Cmd/Ctrl+Shift+G` to the previous, Escape closes it.
 */
export function FindBar() {
    const field = useRef<HTMLInputElement>(null);
    const generation = useRef(0);
    /** A search that finishes after the highlights were cleared must not draw them back. A new search drops this. */
    const closed = useRef(false);
    const actions = useRef<FindActions>({ open() {}, next() {}, previous() {} });
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [result, setResult] = useState<FindResult | null>(null);
    const [focusTick, setFocusTick] = useState(0);
    const [selectOnFocus, setSelectOnFocus] = useState(false);

    const show = (select: boolean) => {
        setSelectOnFocus(select);
        setFocusTick(tick => tick + 1);
        setOpen(true);
    };

    /** Ends the session. A result that arrives afterwards is cleared again, so the highlights stay gone. */
    const stopSearch = () => {
        closed.current = true;
        generation.current += 1;
        setResult(null);

        return window.desktop?.stopFind?.();
    };

    const run = async (text: string, forward: boolean, findNext: boolean) => {
        const desktop = window.desktop;

        if (!desktop?.findInPage || !desktop.stopFind) return;

        if (text === '') {
            await stopSearch();

            return;
        }

        closed.current = false;

        const id = ++generation.current;
        // A new session may start in the field; the step off it handles that. A follow-up must not.
        const restoreCaret = findNext ? null : releaseFieldCaret(field.current);

        try {
            const found = await desktop.findInPage(text, { forward, findNext });

            // A newer search owns the highlights. One that finished after a clear would draw them back, so clear them again.
            if (id !== generation.current) {
                if (closed.current) await desktop.stopFind();

                return;
            }

            // The field contains the query, so one of Chromium's matches is the bar itself.
            const matches = Math.max(0, found.matches - 1);

            if (matches === 0) {
                if (found.matches > 0 && id === generation.current) {
                    await desktop.stopFind();

                    if (id !== generation.current) return;
                }

                setResult({ matches: 0, activeMatchOrdinal: 0 });

                return;
            }

            if (!matchInField(found, field.current)) {
                setResult({ matches, activeMatchOrdinal: Math.min(matches, Math.max(1, found.activeMatchOrdinal)) });

                return;
            }

            const stepped = await desktop.findInPage(text, { forward, findNext: false });

            if (id !== generation.current) {
                if (closed.current) await desktop.stopFind();

                return;
            }

            setResult({ matches, activeMatchOrdinal: pageOrdinal(found.activeMatchOrdinal, stepped.activeMatchOrdinal, matches) });
        }
        finally {
            if (restoreCaret && id === generation.current) restoreCaret();
        }
    };

    const close = () => {
        setOpen(false);
        void stopSearch();
    };

    const step = (forward: boolean) => {
        const starting = !open;

        // Focusing the field puts the caret back in the query. Do that only when the bar is opening, not on each step.
        if (starting || query === '') show(false);

        if (query === '') return;

        // Closing the bar ended the session, so opening it again starts one. A bar that is already open moves through the one it has.
        void run(query, forward, starting);
    };

    // In a code editor (the side panel's Files tab) the keys are the editor's own search; everywhere else they are the window's.
    actions.current = {
        open: () => searchInEditor('open') || show(true),
        next: () => searchInEditor('next') || step(true),
        previous: () => searchInEditor('previous') || step(false),
    };

    useCommands('app', findCommands({
        open: () => actions.current.open(),
        next: () => actions.current.next(),
        previous: () => actions.current.previous(),
    }));

    useLayoutEffect(() => {
        if (!open) return;

        const input = field.current;

        if (!input) return;

        input.focus();

        if (selectOnFocus) input.select();
    }, [open, focusTick, selectOnFocus]);

    useEffect(() => window.desktop?.onFindCommand((command) => {
        const current = actions.current;

        if (command === 'open') current.open();
        else if (command === 'next') current.next();
        else current.previous();
    }), []);

    if (!open) return null;

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            close();

            return;
        }

        if (event.key !== 'Enter') return;

        event.preventDefault();

        if (query === '') return;

        void run(query, !event.shiftKey, false);
    };

    const label = matchLabel(query, result);

    const focusField = (event: MouseEvent<HTMLDivElement>) => {
        if (event.target instanceof Element && event.target.closest('button')) return;

        event.preventDefault();
        field.current?.focus();
    };

    return (
        <div className={ styles.bar } role="search" aria-label="Find in page" onMouseDown={ focusField }>
            <Input
                className={ styles.field }
                variant="transparent"
                type="text"
                size="sm"
                aria-label="Find in page"
                placeholder="Find"
                value={ query }
                inputRef={ field }
                onChange={ (value: string) => {
                    setQuery(value);
                    setResult(null);
                    void run(value, true, true);
                } }
                onKeyDown={ onKeyDown }
            />
            <div className={ styles.trail }>
                <Text
                    variant="xs"
                    color="secondary"
                    className={ styles.count }
                    aria-live="polite"
                    aria-label={ label ?? '' }
                    data-label={ label ?? '' }
                />
                <div className={ styles.steps }>
                    <Button
                        variant="transparent"
                        color="secondary"
                        size="sm"
                        iconOnly
                        aria-label="Previous match"
                        tooltip={ commandTooltip('Previous match', 'find.previous') ?? 'Previous match' }
                        tooltipPlacement="bottom"
                        preventFocusOnPress
                        onPress={ () => step(false) }
                    >
                        <ChevronUp />
                    </Button>
                    <Button
                        variant="transparent"
                        color="secondary"
                        size="sm"
                        iconOnly
                        aria-label="Next match"
                        tooltip={ commandTooltip('Next match', 'find.next') ?? 'Next match' }
                        tooltipPlacement="bottom"
                        preventFocusOnPress
                        onPress={ () => step(true) }
                    >
                        <ChevronDown />
                    </Button>
                    <Button
                        variant="transparent"
                        color="secondary"
                        size="sm"
                        iconOnly
                        aria-label="Close find"
                        tooltip="Close"
                        tooltipPlacement="bottom"
                        preventFocusOnPress
                        onPress={ close }
                    >
                        <Close />
                    </Button>
                </div>
            </div>
        </div>
    );
}
