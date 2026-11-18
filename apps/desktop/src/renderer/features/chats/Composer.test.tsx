// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RootStoreProvider, type RootStore } from '../../stores';
import { Composer } from './Composer';

import type { Chat, CommandResult } from '@clowdy/protocol';
import type { CommandInput } from '../../daemon/transport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const newChat = (id: string): Chat => ({ id, projectId: 'p', title: 'New chat', mode: 'autopilot', createdAt: 0, updatedAt: 0 });
const accepted: CommandResult = { ok: true, requestId: 'request-1', data: {} };
const refused: CommandResult = { ok: false, requestId: 'request-1', error: { code: 'unavailable', message: 'The daemon cannot be reached' } };

let container: HTMLDivElement;
let root: Root;
let sent: CommandInput[];
// Drafts are remembered per chat for the whole session, so each test gets a chat of its own.
let chat: Chat;
let chatNumber = 0;

function mount(result: CommandResult) {
    const command = vi.fn(async (input: CommandInput) => {
        sent.push(input);

        return result;
    });

    act(() => {
        root.render(
            <RootStoreProvider value={ { command } as unknown as RootStore }>
                <Composer chat={ chat } modeLocked={ false } />
            </RootStoreProvider>
        );
    });
}

const field = () => container.querySelector('textarea') as HTMLTextAreaElement;

function type(text: string) {
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field(), text);
        field().dispatchEvent(new Event('input', { bubbles: true }));
    });
}

async function press(key: string, shiftKey = false) {
    await act(async () => {
        field().dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
    });
}

beforeEach(() => {
    sent = [];
    chat = newChat(`c-${ ++chatNumber }`);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('Composer', () => {
    it('sends the trimmed text to the chat on Enter and empties the field', async () => {
        mount(accepted);
        type('  Add a cancel button  ');
        await press('Enter');

        expect(sent).toEqual([{ type: 'chat.send', chatId: chat.id, text: 'Add a cancel button' }]);
        expect(field().value).toBe('');
    });

    it('does not send on Shift+Enter', async () => {
        mount(accepted);
        type('first line');
        await press('Enter', true);

        expect(sent).toEqual([]);
        expect(field().value).toBe('first line');
    });

    it('sends nothing for an empty or blank message', async () => {
        mount(accepted);
        await press('Enter');
        type('   \n ');
        await press('Enter');

        expect(sent).toEqual([]);
    });

    it('puts the words back when the daemon refuses the message', async () => {
        mount(refused);
        type('Add a cancel button');
        await press('Enter');

        expect(sent).toHaveLength(1);
        expect(field().value).toBe('Add a cancel button');
    });

    it('sends with the send button and keeps it off while the field is empty', async () => {
        mount(accepted);

        const send = () => container.querySelector('button[aria-label="Send"]') as HTMLButtonElement;

        expect(send().disabled).toBe(true);

        type('Hello');
        expect(send().disabled).toBe(false);

        await act(async () => send().click());

        expect(sent).toEqual([{ type: 'chat.send', chatId: chat.id, text: 'Hello' }]);
    });

    it('keeps an unsent draft for the chat when it is shown again', () => {
        mount(accepted);
        type('half a thought');
        act(() => root.unmount());
        root = createRoot(container);
        mount(accepted);

        expect(field().value).toBe('half a thought');
    });
});
