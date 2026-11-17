import { useCallback, type KeyboardEvent } from 'react';

import type { Key } from 'react-aria-components';

/**
 * RAC {@link ListBoxItem} `id` is mirrored as `data-key` on the option node.
 * Prefer this over scraping visible labels.
 */
export function autocompleteOptionKey(option: HTMLElement | null): Key | null {
    if (!option) {
        return null;
    }

    return option.dataset.key ?? option.getAttribute('data-key');
}

/** First `[role="option"]` in the listbox controlled by `input`. */
export function autocompleteFirstOption(input: HTMLInputElement): HTMLElement | null {
    const listboxId = input.getAttribute('aria-controls');

    if (!listboxId) {
        return null;
    }

    return document.getElementById(listboxId)?.querySelector<HTMLElement>('[role="option"]') ?? null;
}

/** Option currently pointed at by `aria-activedescendant`, if any. */
export function autocompleteActiveOption(input: HTMLInputElement): HTMLElement | null {
    const activeId = input.getAttribute('aria-activedescendant');

    return activeId ? document.getElementById(activeId) : null;
}

export type UseAutocompleteEnterActionOptions = {
    onAction: (key: Key) => void;
    /**
     * Map a DOM option to its list key. Defaults to {@link autocompleteOptionKey}.
     * Override only when items cannot rely on `data-key` (rare).
     */
    resolveOptionKey?: (option: HTMLElement | null) => Key | null;
    /**
     * When Enter is pressed with no highlighted option (e.g. synthetic “Use path” row
     * that is filtered in but not focused yet).
     */
    fallbackKey?: Key | null | (() => Key | null | undefined);
};

/**
 * Autocomplete Enter does not always fire ListBox `onAction` for custom items.
 * Call the returned handler from Autocomplete/`Input` `onKeyDown`.
 */
export function useAutocompleteEnterAction({
    onAction,
    resolveOptionKey = autocompleteOptionKey,
    fallbackKey,
}: UseAutocompleteEnterActionOptions) {
    return useCallback((event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key !== 'Enter') {
            return;
        }

        event.preventDefault();

        const activeKey = resolveOptionKey(autocompleteActiveOption(event.currentTarget));

        if (activeKey != null) {
            onAction(activeKey);

            return;
        }

        const fallback = typeof fallbackKey === 'function' ? fallbackKey() : fallbackKey;

        if (fallback != null && fallback !== '') {
            onAction(fallback);

            return;
        }

        const firstKey = resolveOptionKey(autocompleteFirstOption(event.currentTarget));

        if (firstKey != null) {
            onAction(firstKey);
        }
    }, [fallbackKey, onAction, resolveOptionKey]);
}
