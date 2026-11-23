// @vitest-environment happy-dom
import { GITHUB_URL, LICENSE_URL, LICENSES_URL, RELEASES_URL } from '@clowdy/constants';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { AboutPage } from './AboutPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let reactRoot: Root;
let transport: FixtureTransport;
let store: RootStore;

const draw = () =>
    act(async () => {
        reactRoot.render(
            <RootStoreProvider value={store}>
                <AboutPage />
            </RootStoreProvider>
        );
    });

const sections = () =>
    [...container.querySelectorAll('section[aria-label]')].map(section => section.getAttribute('aria-label'));
const link = (name: string) =>
    [...container.querySelectorAll<HTMLAnchorElement>('a')].find(anchor => anchor.textContent?.trim() === name)!;
const daemon = () => container.querySelector('[role="status"]')?.textContent;

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
    transport = new FixtureTransport();
    store = new RootStore(transport, { storage: undefined });
});

afterEach(() => {
    act(() => reactRoot.unmount());
    store.dispose();
    container.remove();
    vi.restoreAllMocks();
});

describe('AboutPage', () => {
    it('has the Clowdy, Updates and Credits sections, in that order, and a card for the host inside Updates', async () => {
        await draw();

        expect(sections()).toEqual(['Clowdy', 'Updates', 'Local', 'Credits']);
    });

    it('opens the repository, the releases, the license and the licenses file in the browser', async () => {
        await draw();

        expect(link('Open in GitHub').href).toBe(GITHUB_URL);
        expect(link('Open releases').href).toBe(RELEASES_URL);
        expect(link('Apache-2.0').href).toBe(LICENSE_URL);
        expect(link('Open licenses').href).toBe(LICENSES_URL);
        expect(
            [link('Open in GitHub'), link('Open releases'), link('Apache-2.0'), link('Open licenses')].map(
                anchor => anchor.target
            )
        ).toEqual(['_blank', '_blank', '_blank', '_blank']);
    });

    it('shows the Local host with the version its daemon reports', async () => {
        await draw();

        const card = container.querySelector('[aria-label="Local"]')!;

        expect(card.textContent).toContain('This computer');
        expect(daemon()).toBe((await transport.getHealth()).version);
    });

    it('says it is checking until the daemon answers', async () => {
        vi.spyOn(transport, 'getHealth').mockReturnValue(new Promise(() => undefined));
        await draw();

        expect(daemon()).toBe('Checking…');
    });

    it('says the version is unavailable when the daemon does not answer', async () => {
        vi.spyOn(transport, 'getHealth').mockRejectedValue(new Error('No daemon'));
        await draw();

        expect(daemon()).toBe('Unavailable');
    });
});
