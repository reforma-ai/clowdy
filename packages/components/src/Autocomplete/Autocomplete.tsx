import { Search } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';
import { useCallback, useMemo, useState } from 'react';
import {
    Autocomplete as RACAutocomplete,
    type AutocompleteProps as RACAutocompleteProps,
} from 'react-aria-components';

import { Input } from '../Input';
import { PopoverScroll } from '../Popover';
import {
    elementScrollAxisSource,
    ScrollChromeBars,
    ScrollChromeRoot,
    useScrollChrome,
} from '../Scrollable';
import { Separator } from '../Separator';
import { Show } from '../Show';
import styles from './Autocomplete.module.css';

import type { KeyboardEvent, ReactNode, Ref } from 'react';

export interface AutocompleteProps extends Omit<RACAutocompleteProps, 'children'> {
    /** Constrains the list area and enables scrolling. */
    maxHeight: number | string;
    placeholder?: string;
    /** Name for the search field when it has no placeholder. */
    'aria-label'?: string;
    autoFocus?: boolean;
    isDisabled?: boolean;
    onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
    inputClassName?: string;
    className?: string;
    /** Scroll viewport of the list area (infinite load, etc.). */
    scrollContainerRef?: Ref<HTMLDivElement | null>;
    /** Children scroll themselves (virtualized `ListBox`); Autocomplete only paints the scrollbar. */
    childrenOwnScroll?: boolean;
    /** Off: just the list, for one short enough to scan. Defaults to on. */
    showSearch?: boolean;
    /** Typically a {@link ListBox} (and optional sections / empty state). */
    children: ReactNode;
}

/**
 * Searchable list shell for use inside a {@link Popover}: RAC {@link Autocomplete}
 * + filter input + {@link Separator} + a default {@link PopoverScroll}.
 * Callers own the list content.
 */
export function Autocomplete({
    maxHeight,
    placeholder,
    'aria-label': ariaLabel,
    autoFocus = true,
    isDisabled,
    onKeyDown,
    inputClassName,
    className,
    scrollContainerRef,
    childrenOwnScroll = false,
    showSearch = true,
    children,
    ...autocompleteProps
}: AutocompleteProps) {
    return (
        <div className={ cn(styles.root, className) }>
            <RACAutocomplete { ...autocompleteProps }>
                <Show when={ showSearch }>
                    <Input
                        type="text"
                        size="sm"
                        variant="inline"
                        placeholder={ placeholder }
                        aria-label={ placeholder ? undefined : ariaLabel }
                        autoFocus={ autoFocus }
                        isDisabled={ isDisabled }
                        onKeyDown={ onKeyDown }
                        className={ cn(styles.searchInput, inputClassName) }
                    >
                        <Search slot="prefix" aria-hidden size={ 14 } />
                    </Input>

                    <Separator spacing="xs" />
                </Show>

                <Show
                    when={ childrenOwnScroll }
                    fallback={ (
                        <PopoverScroll maxHeight={ maxHeight } containerRef={ scrollContainerRef }>
                            { children }
                        </PopoverScroll>
                    ) }
                >
                    <ListBoxScrollChrome>{ children }</ListBoxScrollChrome>
                </Show>
            </RACAutocomplete>
        </div>
    );
}

Autocomplete.displayName = 'Autocomplete';

/** Scrollable chrome over a child `ListBox` that owns its overflow (RAC `Virtualizer` needs that). */
function ListBoxScrollChrome({ children }: { children: ReactNode }) {
    const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);

    // Children commit before the host ref fires, so the listbox is already in the DOM.
    const hostRef = useCallback((host: HTMLDivElement | null) => {
        setScrollEl(host?.querySelector<HTMLElement>(':scope > [role="listbox"]') ?? null);
    }, []);

    const verticalSource = useMemo(
        () => elementScrollAxisSource(() => scrollEl, 'vertical'),
        [scrollEl]
    );

    const chrome = useScrollChrome({ verticalSource, sourceKey: scrollEl });

    return (
        <ScrollChromeRoot
            ref={ hostRef }
            rootRef={ chrome.rootRef }
            className={ styles.listBoxScroll }
            vertical
            rootPointerHandlers={ chrome.rootPointerHandlers }
        >
            { children }
            <ScrollChromeBars
                vertical
                setScrollbarV={ chrome.setScrollbarV }
                onPointerDown={ chrome.handlePointerDown }
            />
        </ScrollChromeRoot>
    );
}
