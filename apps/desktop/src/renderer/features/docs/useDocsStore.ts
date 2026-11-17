import { useProjectState, useProjectUi, useRootStore, type ProjectState } from '../../stores';
import { DocsStore } from './DocsStore';

const stores = new WeakMap<ProjectState, DocsStore>();

/**
 * The Documents state of the selected project. It is made once per project and outlives the screen, so unsaved
 * text survives a visit to another section.
 */
export function useDocsStore(): DocsStore {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    let store = stores.get(project);

    if (!store) {
        store = new DocsStore({ project, ui, transport: root.transport, command: input => root.command(input) });
        stores.set(project, store);
    }

    return store;
}
