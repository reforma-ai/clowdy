// @vitest-environment happy-dom
import { GITHUB_URL, LICENSE_URL, LICENSES_URL, RELEASES_URL } from '@clowdy/constants';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { AboutPage } from './AboutPage';

import type { DesktopBridge, UpdateStatus } from '../../../shared/bridge';

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
const rows = () => [...container.querySelectorAll('[aria-label="Local"] > *')].map(row => row.textContent);
const press = (name: string) =>
    act(async () => {
        [...container.querySelectorAll('button')].find(button => button.textContent === name)!.click();
    });

const STATUS: UpdateStatus = { shell: '0.1.2', bundle: 250, ready: null, daemonWaiting: false };

/** A bridge whose status is `status` now, and `change` sends a new one to the page. */
function fakeDesktop(status: UpdateStatus) {
    let listener: ((status: UpdateStatus) => void) | undefined;
    const stop = vi.fn(() => {
        listener = undefined;
    });
    const bridge = {
        getUpdateStatus: vi.fn(async () => status),
        onUpdateStatus: vi.fn((next: (status: UpdateStatus) => void) => {
            listener = next;

            return stop;
        }),
        restartToUpdate: vi.fn(async () => undefined),
        replaceDaemon: vi.fn(async () => undefined),
    };

    window.desktop = bridge as unknown as DesktopBridge;

    return { bridge, stop, change: (next: UpdateStatus) => act(async () => listener?.(next)) };
}

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
    window.desktop = undefined;
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

    it('shows the versions of the app and says nothing of updates when none waits', async () => {
        fakeDesktop(STATUS);
        await draw();

        expect(rows().some(text => text?.includes('Clowdy app') && text.includes('0.1.2 (bundle 250)'))).toBe(true);
        expect(container.textContent).not.toContain('Update ready');
        expect(container.textContent).not.toContain('Daemon update');
    });

    it('shows no app row outside the app, and no update either', async () => {
        await draw();

        expect(container.textContent).not.toContain('Clowdy app');
        expect(container.textContent).not.toContain('Update ready');
    });

    it('leaves out the bundle for a build that runs without one', async () => {
        fakeDesktop({ ...STATUS, bundle: 0 });
        await draw();

        expect(container.textContent).toContain('0.1.2');
        expect(container.textContent).not.toContain('bundle');
    });

    it('offers a restart once an update is installed, and restarts on it', async () => {
        const { bridge, change } = fakeDesktop(STATUS);

        await draw();
        await change({ ...STATUS, ready: 251 });

        expect(container.textContent).toContain('Update ready');
        expect(container.textContent).toContain('Starts the next time Clowdy opens');

        await press('Restart');

        expect(bridge.restartToUpdate).toHaveBeenCalledOnce();
    });

    it('says when the daemon waits for agent runs, and replaces it on request', async () => {
        const { bridge, change } = fakeDesktop({ ...STATUS, daemonWaiting: true });

        await draw();

        expect(container.textContent).toContain('Daemon update');

        await press('Restart now');

        expect(bridge.replaceDaemon).toHaveBeenCalledOnce();

        await change({ ...STATUS, daemonWaiting: false });

        expect(container.textContent).not.toContain('Daemon update');
    });

    it('takes a change that arrives before the first answer as the newer one', async () => {
        const { bridge, change } = fakeDesktop(STATUS);
        let answer: (status: UpdateStatus) => void = () => undefined;

        bridge.getUpdateStatus.mockReturnValue(new Promise(resolve => (answer = resolve)));
        await draw();
        await change({ ...STATUS, ready: 251 });
        await act(async () => answer(STATUS));

        expect(container.textContent).toContain('Update ready');
    });

    it('stops listening when the page closes', async () => {
        const { stop } = fakeDesktop(STATUS);

        await draw();

        expect(stop).not.toHaveBeenCalled();

        act(() => reactRoot.unmount());

        expect(stop).toHaveBeenCalledOnce();

        // The next test's cleanup unmounts this root again.
        reactRoot = createRoot(container);
    });

    it('says the version is unavailable when the daemon does not answer', async () => {
        vi.spyOn(transport, 'getHealth').mockRejectedValue(new Error('No daemon'));
        await draw();

        expect(daemon()).toBe('Unavailable');
    });
});
