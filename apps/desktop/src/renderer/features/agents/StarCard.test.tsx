// @vitest-environment happy-dom
import { GITHUB_URL } from '@clowdy/constants';
import { runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { StarCard } from './StarCard';
import { STAR_CARD_MIN_AGE_MS, starCardPreferences } from './starCardState';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The card on the fixture daemon, whose personal space is twelve days old and whose project has six chats. The test build has no MobX observer plugin, so the card is wrapped by
 * hand here, as the plugin does in the app.
 */

const Observed = observer(StarCard);

let container: HTMLDivElement;
let reactRoot: Root;
let store: RootStore;

const draw = () =>
    act(async () => {
        reactRoot.render(
            <RootStoreProvider value={store}>
                <Observed />
            </RootStoreProvider>
        );
    });

const card = () => container.querySelector('section[aria-label="Star on GitHub"]');
const button = (name: string) =>
    [...container.querySelectorAll('button')].find(
        element => element.textContent?.trim() === name || element.getAttribute('aria-label') === name
    )!;
const press = (element: HTMLElement) => act(async () => element.click());

beforeEach(async () => {
    localStorage.clear();
    runInAction(() => {
        starCardPreferences.dismissed = false;
    });
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
    store = new RootStore(new FixtureTransport(), { storage: undefined });
    await store.load();
    await vi.waitFor(() => expect(store.projectScreenReady).toBe(true));
});

afterEach(() => {
    act(() => reactRoot.unmount());
    store.dispose();
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('the Star on GitHub card', () => {
    it('asks for a star once the person has used Clowdy a while', async () => {
        await draw();

        expect(card()!.textContent).toContain('Having a good time with Clowdy?');
        expect(card()!.textContent).toContain('A star on GitHub helps us grow');
        expect(button('Star on GitHub')).toBeTruthy();
    });

    it('stays away while the data is younger than three days', async () => {
        const oldest = Math.min(...store.projects.map(project => project.createdAt));

        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(oldest + STAR_CARD_MIN_AGE_MS - 1000);
        await draw();

        expect(card()).toBeNull();
    });

    it('opens the repository, closes for good and does not come back', async () => {
        const open = vi.spyOn(window, 'open').mockReturnValue(null);

        await draw();
        await press(button('Star on GitHub'));

        expect(open).toHaveBeenCalledWith(GITHUB_URL, '_blank', 'noreferrer');
        expect(card()).toBeNull();
        expect(localStorage.getItem('clowdy:star-card-dismissed')).toBe('true');
    });

    it('closes for good with its cross, without opening anything', async () => {
        const open = vi.spyOn(window, 'open').mockReturnValue(null);

        await draw();
        await press(button('Close'));

        expect(open).not.toHaveBeenCalled();
        expect(card()).toBeNull();
        expect(localStorage.getItem('clowdy:star-card-dismissed')).toBe('true');
    });

    it('does not show once it was closed before', async () => {
        runInAction(() => starCardPreferences.dismiss());
        await draw();

        expect(card()).toBeNull();
    });
});
