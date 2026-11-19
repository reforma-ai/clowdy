import { Button } from '@clowdy/components/Button';
import { SearchInput } from '@clowdy/components/Input';
import { PanelEmptyRow, PanelLoadingState } from '@clowdy/components/Panel';
import { Text } from '@clowdy/components/Text';
import { Plus } from '@clowdy/icons/14';
import { useRef, type KeyboardEvent } from 'react';

import { commandHint, CommandHotkey, useCommands } from '../../hotkeys';
import { SidebarHeading } from '../../shared';
import { DOCS_SCOPE, docSearchCommand } from './docCommands';
import styles from './DocsSidebar.module.css';
import { DocsTree } from './DocsTree';
import { openNewDocument } from './NewDocumentDialog';

import type { DocsStore } from './DocsStore';

/** The row Tab lands on, which is where the keyboard goes when the person is done with the search field. */
const treeEntry = (field: HTMLElement) => field.closest('aside')?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]') ?? null;

/** The left column: heading, search, and the tree of the docs folder. */
export function DocsSidebar({ store }: { store: DocsStore }) {
    const searchRef = useRef<HTMLInputElement>(null);

    // The `docs` scope is pushed by the screen.
    useCommands(DOCS_SCOPE, [docSearchCommand(() => {
        searchRef.current?.focus();
        searchRef.current?.select();
    })]);

    // Esc clears the text first (the field does that and marks the event handled), and leaves when there is none.
    // Enter is taken here: its keypress would go to the row that has the keyboard by then, and open it.
    const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') event.preventDefault();

        if (event.key === 'Enter' || (event.key === 'Escape' && !event.defaultPrevented)) {
            const entry = treeEntry(event.currentTarget);

            if (entry) entry.focus();
            else event.currentTarget.blur();
        }
    };

    return (
        <aside className={ styles.sidebar } aria-label="Documents">
            <SidebarHeading title="Documents">
                <Button variant="filling" size="sm" iconOnly aria-label="New document" tooltip="New document" onPress={ () => openNewDocument(store) }>
                    <Plus />
                </Button>
            </SidebarHeading>

            <SearchInput
                className={ styles.search }
                size="sm"
                aria-label="Find document"
                placeholder="Find document…"
                value={ store.query }
                onChange={ (query: string) => store.setQuery(query) }
                inputRef={ searchRef }
                onKeyDown={ onSearchKeyDown }
            >
                {/* While there is text the field's own clear button takes this place. */}
                { store.query === '' && commandHint('docs.search') && <span slot="suffix" className={ styles.searchHint }><CommandHotkey id="docs.search" size="xs" /></span> }
            </SearchInput>

            <div className={ styles.body }>
                <SidebarBody store={ store } />
            </div>
        </aside>
    );
}

function SidebarBody({ store }: { store: DocsStore }) {
    if (store.treeStatus === 'loading') return <PanelLoadingState />;

    if (store.treeStatus === 'failed') {
        return (
            <div className={ styles.note }>
                <Text variant="sm" color="secondary">The documents could not be loaded.</Text>
                <Text variant="code" color="secondary">{ store.treeError }</Text>
                <Button variant="bordered" size="sm" onPress={ () => void store.loadTree() }>Retry</Button>
            </div>
        );
    }

    if (store.nodes.length === 0 && store.removedBuffers.length === 0) return <PanelEmptyRow>No documents yet</PanelEmptyRow>;

    if (store.visibleTree.length === 0 && store.removedBuffers.length === 0) return <PanelEmptyRow>{ `Nothing matches “${ store.query.trim() }”` }</PanelEmptyRow>;

    return <DocsTree store={ store } />;
}
