import { Button } from '@clowdy/components/Button';
import { Input } from '@clowdy/components/Input';
import { Text } from '@clowdy/components/Text';
import { ChevronDown, ChevronUp, Close } from '@clowdy/icons/14';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

import { commandTooltip, useCommands } from '../hotkeys';
import styles from './FindBar.module.css';
import { findCommands, type FindActions } from './findCommands';

import type { FindResult } from '../../shared/bridge';

/** `No matches` when the query is nowhere in the window, otherwise `2 of 14`. Nothing while there is nothing to report. */
function matchLabel(query: string, result: FindResult | null): string | null {
    if (query === '' || result === null) return null;

    if (result.matches === 0) return 'No matches';

    return `${ result.activeMatchOrdinal } of ${ result.matches }`;
}

/**
 * Chromium's search of the text drawn in the window: a chat, a settings page, whatever is on screen, including what is scrolled out of view.
 * `Cmd/Ctrl+F` opens it, Enter and `Cmd/Ctrl+G` go to the next match, Shift+Enter and `Cmd/Ctrl+Shift+G` to the previous, Escape closes it.
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
        const found = await desktop.findInPage(text, { forward, findNext });

        // A newer search owns the highlights. One that finished after a clear would draw them back, so clear them again.
        if (id !== generation.current) {
            if (closed.current) await desktop.stopFind();

            return;
        }

        setResult(found);
    };

    const close = () => {
        setOpen(false);
        void stopSearch();
    };

    const step = (forward: boolean) => {
        const starting = !open;

        show(false);

        if (query === '') return;

        // Closing the bar ended the session, so opening it again starts one. A bar that is already open moves through the one it has.
        void run(query, forward, starting);
    };

    actions.current = { open: () => show(true), next: () => step(true), previous: () => step(false) };

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

    return (
        <div className={ styles.bar } role="search" aria-label="Find in page">
            <Input
                className={ styles.field }
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
            <Text variant="xs" color="secondary" className={ styles.count } aria-live="polite">{ label ?? '' }</Text>
            <Button
                variant="filling"
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
                variant="filling"
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
                variant="filling"
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
    );
}
