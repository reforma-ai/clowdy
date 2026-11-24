// @vitest-environment happy-dom
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { ChatView } from './ChatView';
import { composerBannerPreferences } from './composerBannerPreferences';

vi.mock('@clowdy/components/modals', () => ({ openConfirmModal: vi.fn() }));
vi.mock('../../stream/Markdown', () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock('./LastRunPlate', () => ({ LastRunPlate: () => <div data-testid="changes-banner" /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const View = observer(ChatView);

it('shows and hides each banner independently while the chat stays open', async () => {
    const store = new RootStore(new FixtureTransport());
    await store.load();
    await store.refreshAgents();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
        await act(async () =>
            root.render(
                <RootStoreProvider value={store}>
                    <View chat={store.selectedProject!.chats.get('c-1')!} />
                </RootStoreProvider>
            )
        );
        expect(container.querySelector('[aria-label="Chat tasks"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="changes-banner"]')).not.toBeNull();
        act(() => composerBannerPreferences.setShowTasks(false));
        expect(container.querySelector('[aria-label="Chat tasks"]')).toBeNull();
        expect(container.querySelector('[data-testid="changes-banner"]')).not.toBeNull();
        act(() => composerBannerPreferences.setShowChanges(false));
        expect(container.querySelector('[data-testid="changes-banner"]')).toBeNull();
        act(() => composerBannerPreferences.setShowTasks(true));
        expect(container.querySelector('[aria-label="Chat tasks"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="changes-banner"]')).toBeNull();
    } finally {
        act(() => root.unmount());
        container.remove();
        store.dispose();
        composerBannerPreferences.setShowTasks(true);
        composerBannerPreferences.setShowChanges(true);
    }
});
