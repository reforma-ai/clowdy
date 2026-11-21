// @vitest-environment happy-dom
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { chatListPreferences } from '../agents/chatListPreferences';
import { busyEnter } from '../chats/busyEnter';
import { newChatDefaults } from '../chats/newChatDefaults';
import { swipeToReply } from '../chats/swipeReplyPreference';
import { ChatPage } from './ChatPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The babel plugin that makes the app's components observers does not run under Vitest.
const Page = observer(ChatPage);

let container: HTMLDivElement;
let root: Root;
let store: RootStore;

const LABEL = 'Send a message while the agent is working';
const SWIPE = 'Swipe a message to reply';
const swipeSwitch = () => container.querySelector<HTMLInputElement>(`input[aria-label="${ SWIPE }"]`)!;
const radio = (group: string, label: string) => [...container.querySelectorAll<HTMLElement>(`[aria-label="${ group }"] [role="radio"]`)].find(item => item.textContent === label)!;
const checked = (group: string) => container.querySelector(`[aria-label="${ group }"] [role="radio"][aria-checked="true"]`)?.textContent;
const finished = () => container.querySelector<HTMLInputElement>('input[aria-label="Finished threads"]')!;
const labels = (group: string) => [...container.querySelectorAll<HTMLElement>(`[aria-label="${ group }"] [role="radio"]`)].map(item => item.textContent);

function reset() {
    busyEnter.setMode('steer');
    swipeToReply.setEnabled(true);
    newChatDefaults.setEngine(undefined);
    newChatDefaults.setMode(undefined);
    chatListPreferences.setSort('activity');
    chatListPreferences.setShowFinishedThreads(true);
}

beforeEach(async () => {
    reset();
    store = new RootStore(new FixtureTransport(), { storage: undefined });
    await store.load();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<RootStoreProvider value={ store }><Page /></RootStoreProvider>));
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
    it('offers how a message sent while the agent works goes, steering by default', () => {
        expect(checked(LABEL)).toBe('Steer');
        expect(container.textContent).toContain('Steer it into the current turn, or queue it for the next one. Press Ctrl+Enter to use the other option.');
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

    it('offers the app\'s agent and mode of new chats, with no Default, Last used at first', () => {
        expect(labels('Agent for new chats')).toEqual(['Last used', 'Claude Code', 'Codex', 'Cursor']);
        expect(labels('Mode for new chats')).toEqual(['Last used', 'Hands-off', 'Hands-on']);
        expect([checked('Agent for new chats'), checked('Mode for new chats')]).toEqual(['Last used', 'Last used']);
    });

    it('keeps the app\'s agent and mode of new chats on this computer, and Last used clears each', () => {
        act(() => radio('Agent for new chats', 'Codex').click());
        act(() => radio('Mode for new chats', 'Hands-on').click());

        expect([newChatDefaults.engine, newChatDefaults.mode]).toEqual(['codex', 'semi']);
        expect([checked('Agent for new chats'), checked('Mode for new chats')]).toEqual(['Codex', 'Hands-on']);

        act(() => radio('Agent for new chats', 'Last used').click());
        act(() => radio('Mode for new chats', 'Last used').click());

        expect([newChatDefaults.engine, newChatDefaults.mode]).toEqual([undefined, undefined]);
    });

    it('offers the order of the chats and the finished threads of the Agents list, as the list\'s own menu does', () => {
        expect(labels('Sort chats by')).toEqual(['Last activity', 'Created']);
        expect(checked('Sort chats by')).toBe('Last activity');
        expect(finished().checked).toBe(true);
    });

    it('keeps the order of the chats and the finished threads for the list, in every project', () => {
        act(() => radio('Sort chats by', 'Created').click());
        act(() => finished().click());

        expect([chatListPreferences.sort, chatListPreferences.showFinishedThreads]).toEqual(['created', false]);
        expect(checked('Sort chats by')).toBe('Created');
        expect(finished().checked).toBe(false);

        act(() => radio('Sort chats by', 'Last activity').click());
        act(() => finished().click());

        expect([chatListPreferences.sort, chatListPreferences.showFinishedThreads]).toEqual(['activity', true]);
    });
});
