import { Button } from '@clowdy/components/Button';
import { Input } from '@clowdy/components/Input';
import { Text } from '@clowdy/components/Text';
import { searchInEditor } from '@clowdy/file-manager/editor-search';
import { ChevronDown, ChevronUp, Close } from '@clowdy/icons/14';
import { type KeyboardEvent, type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { commandTooltip, useCommands } from '../hotkeys';
import styles from './FindBar.module.css';
import { type FindActions, findCommands } from './findCommands';
import { clearMatches, findMatches, paintMatches, revealMatch, stepFrom } from './pageSearch';

/** Where the person is among the hits: the one they are on (from 0) and how many there are. */
interface Position {
    index: number;
    total: number;
}

/** `No matches` when the query is nowhere in the window, otherwise `2 of 14`. Nothing while there is nothing to report. */
function matchLabel(query: string, position: Position | null): string | null {
    if (query === '' || position === null) return null;

    if (position.total === 0) return 'No matches';

    return `${position.index + 1} of ${position.total}`;
}

/**
 * Search of the text drawn in the window: a chat, a settings page, whatever is on screen, including what is scrolled out of view (`pageSearch.ts`).
 * The bar itself is not searched, and the focus stays in its field the whole time. `Cmd/Ctrl+F` opens it, Enter and `Cmd/Ctrl+G` go to the next match,
 * Shift+Enter and `Cmd/Ctrl+Shift+G` to the previous, Escape closes it.
 */
export function FindBar() {
    const bar = useRef<HTMLDivElement>(null);
    const field = useRef<HTMLInputElement>(null);
    /** The hit the person is on: the next search goes on from it, so more typing stays on the place and a step goes to its neighbour. */
    const current = useRef<Range | null>(null);
    const actions = useRef<FindActions>({ open() {}, next() {}, previous() {} });
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [position, setPosition] = useState<Position | null>(null);
    const [focusTick, setFocusTick] = useState(0);
    const [selectOnFocus, setSelectOnFocus] = useState(false);

    const show = (select: boolean) => {
        setSelectOnFocus(select);
        setFocusTick(tick => tick + 1);
        setOpen(true);
    };

    const clear = () => {
        current.current = null;
        clearMatches();
        setPosition(null);
    };

    /** Looks for `text` again and goes to the hit after (or before) the one the person is on. The page may have changed since the last search, so every step searches again. */
    const search = (text: string, forward: boolean, inclusive: boolean) => {
        const matches = findMatches(text, bar.current);
        const index = stepFrom(matches, current.current, forward, inclusive);

        if (index === -1) {
            current.current = null;
            clearMatches();
            setPosition({ index: 0, total: 0 });

            return;
        }

        current.current = matches[index];
        paintMatches(matches, index);
        revealMatch(matches[index]);
        setPosition({ index, total: matches.length });
    };

    const close = () => {
        setOpen(false);
        clear();
    };

    const openBar = () => {
        // A bar that was closed starts again from its query, so the page shows the hits it had.
        if (!open && query !== '') search(query, true, true);

        show(true);
    };

    const step = (forward: boolean) => {
        // Focusing the field puts the caret back in the query. Do that only when the bar is opening, not on each step.
        if (!open || query === '') show(false);

        if (query === '') return;

        search(query, forward, false);
    };

    // In a code editor (the side panel's Files tab) the keys are the editor's own search; everywhere else they are the window's.
    actions.current = {
        open: () => searchInEditor('open') || openBar(),
        next: () => searchInEditor('next') || step(true),
        previous: () => searchInEditor('previous') || step(false),
    };

    useCommands(
        'app',
        findCommands({
            open: () => actions.current.open(),
            next: () => actions.current.next(),
            previous: () => actions.current.previous(),
        })
    );

    useLayoutEffect(() => {
        if (!open) return;

        const input = field.current;

        if (!input) return;

        input.focus();

        if (selectOnFocus) input.select();
    }, [open, focusTick, selectOnFocus]);

    useEffect(
        () =>
            window.desktop?.onFindCommand(command => {
                const handler = actions.current;

                if (command === 'open') handler.open();
                else if (command === 'next') handler.next();
                else handler.previous();
            }),
        []
    );

    // The hits are painted on the document, not in this component: they must go when it does.
    useEffect(() => clearMatches, []);

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

        search(query, !event.shiftKey, false);
    };

    const label = matchLabel(query, position);

    // The rest of the bar gives the focus to the field. The field and the buttons keep their own press.
    const focusField = (event: MouseEvent<HTMLDivElement>) => {
        if (event.target instanceof Element && event.target.closest('button, input')) return;

        event.preventDefault();
        field.current?.focus();
    };

    return (
        <div ref={bar} className={styles.bar} role="search" aria-label="Find in page" onMouseDown={focusField}>
            <Input
                className={styles.field}
                variant="transparent"
                type="text"
                size="sm"
                aria-label="Find in page"
                placeholder="Find"
                value={query}
                inputRef={field}
                onChange={(value: string) => {
                    setQuery(value);

                    if (value === '') clear();
                    else search(value, true, true);
                }}
                onKeyDown={onKeyDown}
            />
            <div className={styles.trail}>
                <Text variant="xs" color="secondary" className={styles.count} aria-live="polite">
                    {label}
                </Text>
                <div className={styles.steps}>
                    <Button
                        variant="filling"
                        size="xs"
                        iconOnly
                        aria-label="Previous match"
                        tooltip={commandTooltip('Previous match', 'find.previous') ?? 'Previous match'}
                        tooltipPlacement="bottom"
                        preventFocusOnPress
                        onPress={() => step(false)}
                    >
                        <ChevronUp />
                    </Button>
                    <Button
                        variant="filling"
                        size="xs"
                        iconOnly
                        aria-label="Next match"
                        tooltip={commandTooltip('Next match', 'find.next') ?? 'Next match'}
                        tooltipPlacement="bottom"
                        preventFocusOnPress
                        onPress={() => step(true)}
                    >
                        <ChevronDown />
                    </Button>
                    <Button
                        variant="filling"
                        size="xs"
                        iconOnly
                        aria-label="Close find"
                        tooltip="Close"
                        tooltipPlacement="bottom"
                        preventFocusOnPress
                        onPress={close}
                    >
                        <Close />
                    </Button>
                </div>
            </div>
        </div>
    );
}
