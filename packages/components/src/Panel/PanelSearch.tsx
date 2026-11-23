import { Search } from '@clowdy/icons/14';

import { SearchInput, type SearchInputProps } from '../Input';
import { Show } from '../Show';
import { Spinner } from '../Spinner';
import { PanelHeader } from './Panel';
import styles from './Panel.module.css';

import type { Ref } from 'react';

export type PanelSearchProps = {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    'aria-label'?: string;
    /** When false, the field is not rendered. */
    isOpen?: boolean;
    autoFocus?: boolean;
    /** Shows a spinner in the input suffix (e.g. assets search in flight). */
    isPending?: boolean;
    inputRef?: Ref<HTMLInputElement>;
    onKeyDown?: SearchInputProps['onKeyDown'];
};

/** Shared search field for side panels — shown when the header search toggle is on. */
export function PanelSearch({
    value,
    onChange,
    placeholder,
    'aria-label': ariaLabel,
    isOpen = true,
    autoFocus = false,
    isPending = false,
    inputRef,
    onKeyDown,
}: PanelSearchProps) {
    return (
        <Show when={isOpen}>
            <div className={styles.panelSearch}>
                <SearchInput
                    size="sm"
                    variant="inline"
                    value={value}
                    onChange={onChange}
                    onKeyDown={onKeyDown}
                    placeholder={placeholder}
                    aria-label={ariaLabel}
                    autoFocus={autoFocus}
                    inputRef={inputRef}
                    className={styles.panelSearchInput}
                >
                    {isPending ? <Spinner slot="suffix" size="xs" aria-label="Searching" /> : null}
                </SearchInput>
            </div>
        </Show>
    );
}

PanelSearch.displayName = 'PanelSearch';

/** Header toggle that opens {@link PanelSearch}. */
export function PanelSearchButton({
    isOpen,
    onPress,
    tooltip = 'Search',
}: {
    isOpen: boolean;
    onPress: () => void;
    tooltip?: string;
}) {
    return (
        <PanelHeader.Button isPressed={isOpen} tooltip={tooltip} onPress={onPress}>
            <Search />
        </PanelHeader.Button>
    );
}

PanelSearchButton.displayName = 'PanelSearchButton';
