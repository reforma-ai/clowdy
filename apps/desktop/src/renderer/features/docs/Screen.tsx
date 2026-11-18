import { useEffect } from 'react';

import { useCommands, useHotkeyScope } from '../../hotkeys';
import { SidebarLayout } from '../../shared';
import { DOCS_SCOPE, docSaveCommand } from './docCommands';
import { DocsMain } from './DocsMain';
import { DocsSidebar } from './DocsSidebar';
import { useDocsStore } from './useDocsStore';

/** Documents: the project's docs folder as a tree on the left, the open document on the right. */
export function Screen() {
    const store = useDocsStore();

    useEffect(() => store.activate(), [store]);

    useHotkeyScope(DOCS_SCOPE);
    useCommands(DOCS_SCOPE, [docSaveCommand(store)]);

    return (
        <SidebarLayout screen="docs" defaultWidth={ 330 } sidebar={ <DocsSidebar store={ store } /> }>
            <DocsMain store={ store } />
        </SidebarLayout>
    );
}
