import { Button } from '@clowdy/components/Button';
import { Search } from '@clowdy/icons/14';

import { openQuickSearch, QUICK_SEARCH_COMMAND } from '../features/quickSearch';
import { CommandHotkey } from '../hotkeys';
import { useRootStore } from '../stores';
import styles from './SearchButton.module.css';

/**
 * The quick search palette's entry in the title band, in the middle of it as a code editor's command center is: a plate that reads "Search" with the keys of the palette at
 * its end, and opens the palette on its first tab, as the keys do (`openQuickSearch` keeps a palette that is open and a dialog over which none opens). It is not a field:
 * what is typed goes into the palette's own.
 */
export function SearchButton() {
    const root = useRootStore();

    return (
        <Button
            variant="ghost"
            size="sm"
            className={styles.button}
            contentClassName={styles.content}
            aria-label="Search"
            onPress={() => openQuickSearch(root)}
        >
            <Search aria-hidden />
            <span className={styles.label}>Search</span>
            <CommandHotkey id={QUICK_SEARCH_COMMAND} size="xs" />
        </Button>
    );
}
