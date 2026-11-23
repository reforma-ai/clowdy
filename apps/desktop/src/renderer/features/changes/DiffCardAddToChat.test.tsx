// @vitest-environment happy-dom
import { EditorView } from '@codemirror/view';
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_PROJECT_ID, FIXTURE_WORKSPACE_CHAT_ID, withFixtureWorkspace } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { registerComposer } from '../chats/composerBridge';
import ChangesTab from './ChangesTab';
import { changesSidebarLayout } from './sidebarLayout';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Add to chat over a diff card: the real diff view and the real selection button, in the Changes tab of the fixture chat that works in a worktree. A selection in a card
 * quotes the file's path and the lines of its new text into the message box that is mounted, and with none mounted there is no button.
 */

// happy-dom has no layout: the view builds its resizable group once its box has a width, which it is told.
vi.mock('./useBoxWidth', () => ({ useBoxWidth: () => [() => undefined, 900] }));
// The babel plugin that makes the app's components observers does not run under Vitest: the parts of the tab are, to follow the model they read.
vi.mock('./ChangesView', async importOriginal => ({ ...await importOriginal<typeof import('./ChangesView')>(), ChangesView: observer((await importOriginal<typeof import('./ChangesView')>()).ChangesView) }));
vi.mock('./ChangesList', async importOriginal => ({ ChangesList: observer((await importOriginal<typeof import('./ChangesList')>()).ChangesList) }));
vi.mock('./ChangesToolbar', async importOriginal => ({ ...await importOriginal<typeof import('./ChangesToolbar')>(), ChangesToolbar: observer((await importOriginal<typeof import('./ChangesToolbar')>()).ChangesToolbar) }));
vi.mock('./ChangesSidebar', async importOriginal => ({ ...await importOriginal<typeof import('./ChangesSidebar')>(), ChangesSidebar: observer((await importOriginal<typeof import('./ChangesSidebar')>()).ChangesSidebar) }));
vi.mock('./DiffCard', async importOriginal => ({ DiffCard: observer((await importOriginal<typeof import('./DiffCard')>()).DiffCard) }));
vi.mock('./PullRequestChip', async importOriginal => ({ PullRequestChip: observer((await importOriginal<typeof import('./PullRequestChip')>()).PullRequestChip) }));

/** What watches elements for the scroller's edge (the cards and the diff views): it says nothing until the test brings everything near. */
const watchers = new Set<{ callback: IntersectionObserverCallback; targets: Set<Element> }>();

class FakeIntersectionObserver {
    readonly #entry: { callback: IntersectionObserverCallback; targets: Set<Element> };

    constructor(callback: IntersectionObserverCallback) {
        this.#entry = { callback, targets: new Set() };
        watchers.add(this.#entry);
    }

    observe(target: Element) {
        this.#entry.targets.add(target);
    }

    disconnect() {
        watchers.delete(this.#entry);
    }

    unobserve() {}
    takeRecords() {
        return [];
    }
}

const bringNear = () => act(async () => {
    for (const { callback, targets } of [...watchers]) {
        callback([...targets].map(target => ({ isIntersecting: true, target }) as IntersectionObserverEntry), {} as IntersectionObserver);
    }
});

const settle = () => act(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
});

let container: HTMLDivElement;
let root: Root;
let store: RootStore;

const Tab = observer(ChangesTab);
const card = (path: string) => container.querySelector<HTMLElement>(`[data-card="${ path }"]`)!;
const editorOf = (path: string) => EditorView.findFromDOM(card(path).querySelector<HTMLElement>('.cm-editor')!)!;
const button = (path: string) => card(path).querySelector<HTMLButtonElement>('.cm-tooltip button');
const select = (editor: EditorView, from: number, to: number) => act(async () => editor.dispatch({ selection: { anchor: from, head: to } }));

async function draw() {
    store = new RootStore(new FixtureTransport({ data: withFixtureWorkspace(createFixtureData()) }));
    await store.load();
    store.selectProject(FIXTURE_PROJECT_ID);
    store.ui.forProject(FIXTURE_PROJECT_ID).openChat(FIXTURE_WORKSPACE_CHAT_ID);
    act(() => root.render(<RootStoreProvider value={ store }><Tab /></RootStoreProvider>));
    await settle();
    // The cards come near, ask for their texts, and the diff views come near and build their editors.
    await bringNear();
    await settle();
    await bringNear();
    await settle();
}

beforeEach(() => {
    localStorage.clear();
    watchers.clear();
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    HTMLElement.prototype.scrollIntoView = () => undefined;

    if (!changesSidebarLayout.open) changesSidebarLayout.toggle();

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    store.dispose();
    vi.unstubAllGlobals();
    localStorage.clear();
});

describe('Add to chat over a diff card', () => {
    it('offers nothing while no message box is mounted', async () => {
        await draw();

        const editor = editorOf('src/booking/price.ts');

        await select(editor, 0, 10);
        await settle();

        expect(button('src/booking/price.ts')).toBeNull();
    });

    it('quotes the words selected in a card with the file\'s path and their lines of the new text', async () => {
        const quoted: string[] = [];
        const unregister = registerComposer(text => quoted.push(text));

        await draw();

        const editor = editorOf('src/booking/price.ts');
        const lines = editor.state.doc.toString().split('\n');

        // Lines 1 and 2, whole: the selection ends at the start of line 3, which is not part of it.
        await select(editor, 0, lines[0]!.length + 1 + lines[1]!.length + 1);
        expect(button('src/booking/price.ts')?.textContent).toContain('Add to chat');

        await act(async () => button('src/booking/price.ts')!.click());

        expect(quoted).toEqual([`\`src/booking/price.ts:1-2\`\n\`\`\`ts\n${ lines[0] }\n${ lines[1] }\n\`\`\``]);
        expect(editor.state.selection.main.empty).toBe(true);

        unregister();
    });
});
