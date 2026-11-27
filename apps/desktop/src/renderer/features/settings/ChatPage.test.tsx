// @vitest-environment happy-dom
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { chatListPreferences } from '../agents/chatListPreferences';
import { busyEnter } from '../chats/busyEnter';
import { ComposerBannerPreferences, composerBannerPreferences } from '../chats/composerBannerPreferences';
import { newChatDefaults } from '../chats/newChatDefaults';
import { swipeToReply } from '../chats/swipeReplyPreference';
import { named } from './accessibleName';
import { ChatPage } from './ChatPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The babel plugin that makes the app's components observers does not run under Vitest.
const Page = observer(ChatPage);

let container: HTMLDivElement;
let root: Root;
let store: RootStore;

const LABEL = 'Send a message while the agent is working';
const SWIPE = 'Swipe a message to reply';
const swipeSwitch = () => named<HTMLInputElement>(container, 'input', SWIPE)!;
const radio = (group: string, label: string) =>
    [...named(container, '[aria-labelledby]', group)!.querySelectorAll<HTMLElement>('[role="radio"]')].find(
        item => item.textContent === label
    )!;
const checked = (group: string) =>
    named(container, '[aria-labelledby]', group)?.querySelector('[role="radio"][aria-checked="true"]')?.textContent;
const finished = () => named<HTMLInputElement>(container, 'input', 'Show completed threads')!;
const labels = (group: string) =>
    [...named(container, '[aria-labelledby]', group)!.querySelectorAll<HTMLElement>('[role="radio"]')].map(
        item => item.textContent
    );

function reset() {
    busyEnter.setMode('steer');
    composerBannerPreferences.setShowChanges(true);
    composerBannerPreferences.setShowTasks(true);
    swipeToReply.setEnabled(true);
    newChatDefaults.setEngine(undefined);
    newChatDefaults.setMode(undefined);
    chatListPreferences.setShowFinishedThreads(true);
}

beforeEach(async () => {
    reset();
    store = new RootStore(new FixtureTransport(), { storage: undefined });
    await store.load();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() =>
        root.render(
            <RootStoreProvider value={store}>
                <Page />
            </RootStoreProvider>
        )
    );
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
    });
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    store.dispose();
    reset();
});

describe('ChatPage', () => {
    it('leaves the worktree prefix to Source Control', () => {
        expect(named(container, 'input', 'Branch prefix')).toBeNull();
    });

    it('stores the two composer banner choices independently', () => {
        const changes = named<HTMLInputElement>(container, 'input', 'Show last run changes')!;
        const tasks = named<HTMLInputElement>(container, 'input', 'Show tasks')!;
        expect([changes.checked, tasks.checked]).toEqual([true, true]);
        act(() => changes.click());
        expect([changes.checked, tasks.checked]).toEqual([false, true]);
        act(() => tasks.click());
        const restored = new ComposerBannerPreferences(window.localStorage);
        expect([restored.showChanges, restored.showTasks]).toEqual([false, false]);
        act(() => changes.click());
        expect([changes.checked, tasks.checked]).toEqual([true, false]);
    });

    it('offers how a message sent while the agent works goes, steering by default', () => {
        expect(checked(LABEL)).toBe('Steer');
        expect(container.textContent).toContain(
            'Steer it into the current turn, or queue it for the next one. Press Ctrl+Enter to use the other option.'
        );
        // The tips of the choices are tooltips, not text under the row.
        expect(container.textContent).not.toContain('Steer sends your message');
    });

    it('keeps the choice for the message box', () => {
        act(() => radio(LABEL, 'Queue').click());

        expect(busyEnter.mode).toBe('queue');
        expect(checked(LABEL)).toBe('Queue');
    });

    it('offers to swipe a message to reply, on by default, with a line that says what it does and no period after it', () => {
        expect(container.textContent).toContain(SWIPE);
        expect(container.textContent).toContain('Swipe left over a message and let go to reply to it');
        expect(container.textContent).not.toContain('Swipe left over a message and let go to reply to it.');
        expect(swipeSwitch().checked).toBe(true);
        expect(swipeToReply.enabled).toBe(true);
    });

    it('keeps the swipe setting on this computer, off and on again', () => {
        act(() => swipeSwitch().click());

        expect(swipeToReply.enabled).toBe(false);
        expect(swipeSwitch().checked).toBe(false);
        expect(localStorage.getItem('clowdy:swipe-to-reply')).toBe('false');

        act(() => swipeSwitch().click());

        expect(swipeToReply.enabled).toBe(true);
        expect(swipeSwitch().checked).toBe(true);
        expect(localStorage.getItem('clowdy:swipe-to-reply')).toBe('true');
    });

    it("offers the app's agent and mode of new chats, with no Default, Last used at first", () => {
        expect(labels('Agent')).toEqual(['Last used', 'Claude Code', 'Codex', 'Cursor']);
        expect(labels('Mode')).toEqual(['Last used', 'Hands-off', 'Hands-on']);
        expect([checked('Agent'), checked('Mode')]).toEqual(['Last used', 'Last used']);
    });

    it("keeps the app's agent and mode of new chats on this computer, and Last used clears each", () => {
        act(() => radio('Agent', 'Codex').click());
        act(() => radio('Mode', 'Hands-on').click());

        expect([newChatDefaults.engine, newChatDefaults.mode]).toEqual(['codex', 'semi']);
        expect([checked('Agent'), checked('Mode')]).toEqual(['Codex', 'Hands-on']);

        act(() => radio('Agent', 'Last used').click());
        act(() => radio('Mode', 'Last used').click());

        expect([newChatDefaults.engine, newChatDefaults.mode]).toEqual([undefined, undefined]);
    });

    it('keeps the finished threads filter and removes the automatic chat sort setting', () => {
        expect(container.querySelector('[aria-label="Sort chats by"]')).toBeNull();
        expect(finished().checked).toBe(true);

        act(() => finished().click());
        expect(chatListPreferences.showFinishedThreads).toBe(false);
        expect(finished().checked).toBe(false);
    });
});
