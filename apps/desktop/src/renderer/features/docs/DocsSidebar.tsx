import { Button } from '@clowdy/components/Button';
import { SearchInput } from '@clowdy/components/Input';
import { PanelEmptyRow, PanelLoadingState } from '@clowdy/components/Panel';
import { Text } from '@clowdy/components/Text';
import { Plus } from '@clowdy/icons/14';

import { SidebarHeading } from '../../shared';
import styles from './DocsSidebar.module.css';
import { DocsTree } from './DocsTree';
import { openNewDocument } from './NewDocumentDialog';

import type { DocsStore } from './DocsStore';

/** The left column: heading, search, and the tree of the docs folder. */
export function DocsSidebar({ store }: { store: DocsStore }) {
    return (
        <aside className={ styles.sidebar } aria-label="Documents">
            <SidebarHeading title="Documents">
                <Button variant="filling" size="sm" iconOnly aria-label="New document" tooltip="New document" onPress={ () => openNewDocument(store) }>
                    <Plus />
                </Button>
            </SidebarHeading>

            <SearchInput
                size="sm"
                aria-label="Find document"
                placeholder="Find document…"
                value={ store.query }
                onChange={ (query: string) => store.setQuery(query) }
            />

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
