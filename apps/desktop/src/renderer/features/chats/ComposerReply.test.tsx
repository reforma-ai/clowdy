// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RootStoreProvider, type RootStore } from '../../stores';
import { Composer, type ComposerHandle } from './Composer';
import { draftOf, editDraftKey, messageOf } from './composerDrafts';
import { setFiles, type DraftFile } from './composerFiles';
import { dropReplyQuote, replyQuoteOf, setReplyQuote } from './composerQuotes';
import { modelStore } from './modelTestKit';

import type { Chat, CommandResult } from '@clowdy/protocol';
import type { Editor } from '@tiptap/core';
import type { CommandInput } from '../../daemon/transport';
import type { ReplyMessage } from '../../stream/MessageActions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Reply to a whole message: `ComposerHandle.reply` makes the message the card above the field, per box, and the card is sent as a quote in front of the words. The
 * card is not text of the draft: what is typed is all the draft holds, and a selection quoted with `ComposerHandle.quote` still goes into the draft as `> text`.
 */

const accepted: CommandResult = { ok: true, requestId: 'request-1', data: {} };
const refused: CommandResult = { ok: false, requestId: 'request-1', error: { code: 'unavailable', message: 'The daemon cannot be reached' } };

const person: ReplyMessage = { role: 'user', text: 'Use the blue one' };
const answer: ReplyMessage = { role: 'assistant', text: 'The form is fixed.' };

let container: HTMLDivElement;
let root: Root;
let handle: ComposerHandle | null;
let sent: CommandInput[];
// Drafts, files and quotes are remembered per chat for the whole session, so each test gets chats of its own.
let chat: Chat;
let other: Chat;
let chatNumber = 0;

const chatOf = (id: string, engine?: string): Chat => ({ id, projectId: 'p', title: 'Chat', mode: 'autopilot', orchestratorRunId: 'r-1', createdAt: 0, updatedAt: 0, ...(engine && { engine }) });

type Page = { chat?: Chat; edit?: { draftKey: string; onSubmit?: () => void } };

/** `answers` is what the daemon says to each command in turn (the last one repeats). */
async function mount(page: Page = { chat }, ...answers: Array<CommandResult | Promise<CommandResult>>) {
    let calls = 0;
    const command = vi.fn(async (input: CommandInput) => {
        sent.push(input);

        return answers[Math.min(calls++, answers.length - 1)] ?? accepted;
    });
    const transport = {
        getDocsTree: vi.fn(async () => []),
        getProjectFiles: vi.fn(async () => []),
        getSkills: vi.fn(async () => ({ entries: [], tokens: 0, warnings: [] })),
    };
    const store = { command, transport, skillsRevision: 0, selectedProject: { project: { id: 'p' }, taskList: [] }, ...await modelStore() };

    await act(async () => {
        root.render(
            <RootStoreProvider value={ store as unknown as RootStore }>
                <Composer
                    ref={ (value) => {
                        handle = value;
                    } }
                    chat={ page.chat }
                    run={ undefined }
                    editMode={ page.edit && { draftKey: page.edit.draftKey, onSubmit: page.edit.onSubmit ?? (() => undefined), onCancel: () => undefined } }
                />
            </RootStoreProvider>
        );
    });
}

const field = () => container.querySelector<HTMLElement>('[contenteditable="true"]')!;
const editor = () => (field() as HTMLElement & { editor: Editor }).editor;
const card = () => container.querySelector<HTMLElement>('[role="group"][aria-label^="Replying to"]');
const cardWords = () => card()?.querySelector('p')?.textContent;
const sendButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
const reply = (message: ReplyMessage) => act(async () => handle!.reply(message));
const pressEnter = () => act(async () => {
    field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
});

function type(value: string) {
    act(() => {
        editor().commands.insertContent(value);
    });
}

const readyFile = (name: string): DraftFile => ({ key: `k-${ name }`, name, mediaType: 'text/plain', size: 1, status: 'ready', attachment: { id: `a-${ name }`, name, mediaType: 'text/plain', size: 1 } });

beforeEach(() => {
    sent = [];
    handle = null;
    chatNumber += 1;
    chat = chatOf(`c-reply-${ chatNumber }`, 'claude');
    other = chatOf(`c-reply-other-${ chatNumber }`);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setFiles(chat.id, []);

    for (const key of [chat.id, other.id, editDraftKey(chat.id, 'i-1')]) dropReplyQuote(key);
});

describe('the card of a reply', () => {
    it('stands above the field with who wrote the message, the words and an X, and the draft stays empty', async () => {
        await mount();
        await reply(person);

        expect(card()).not.toBeNull();
        expect(card()!.textContent).toContain('You');
        expect(cardWords()).toBe('Use the blue one');
        expect(card()!.querySelector('button[aria-label="Remove quote"]')).not.toBeNull();
        // Above the field, in the area where files show.
        expect(card()!.compareDocumentPosition(field()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        // Not text of the draft.
        expect(editor().getText()).toBe('');
        expect(messageOf(draftOf(chat.id))).toBe('');
    });

    it('names the agent for an answer, as the person knows it, and calls it Assistant when it has no name', async () => {
        await mount();
        await reply(answer);

        expect(card()!.getAttribute('aria-label')).toBe('Replying to Claude Code');
        expect(card()!.textContent).toContain('Claude Code');

        await mount({ chat: other });
        await reply(answer);

        expect(card()!.getAttribute('aria-label')).toBe('Replying to Assistant');
    });

    it('puts the focus in the field', async () => {
        await mount();

        expect(document.activeElement).not.toBe(field());

        await reply(person);

        expect(document.activeElement).toBe(field());
    });

    it('holds one message: replying to another takes the place of the first', async () => {
        await mount();
        await reply(person);
        await reply(answer);

        expect(container.querySelectorAll('[role="group"][aria-label^="Replying to"]')).toHaveLength(1);
        expect(cardWords()).toBe('The form is fixed.');
        expect(card()!.textContent).toContain('Claude Code');
        expect(replyQuoteOf(chat.id)).toEqual(answer);
    });

    it('goes with the X, and the focus goes back to the field', async () => {
        await mount();
        await reply(person);
        act(() => field().blur());
        await act(async () => card()!.querySelector<HTMLButtonElement>('button[aria-label="Remove quote"]')!.click());

        expect(card()).toBeNull();
        expect(replyQuoteOf(chat.id)).toBeUndefined();
        expect(document.activeElement).toBe(field());
    });

    it('is kept for each chat: going to another chat and back leaves each box with its own', async () => {
        await mount();
        await reply(person);
        await mount({ chat: other });

        expect(card()).toBeNull();

        await reply(answer);

        expect(cardWords()).toBe('The form is fixed.');

        await mount();

        expect(cardWords()).toBe('Use the blue one');
    });

    it('is no part of the box of an edit frame, whatever the chat holds', async () => {
        const key = editDraftKey(chat.id, 'i-1');

        setReplyQuote(chat.id, person);
        setReplyQuote(key, answer);
        await mount({ chat, edit: { draftKey: key } });

        expect(card()).toBeNull();

        // The box at the bottom of the same chat has its card all the while.
        await mount();

        expect(cardWords()).toBe('Use the blue one');
    });

    it('does not take a selection: words quoted with `quote` go into the draft as `> text` and no card stands', async () => {
        await mount();
        await act(async () => handle!.quote('the footer'));

        expect(card()).toBeNull();
        expect(messageOf(draftOf(chat.id))).toBe('> the footer');
    });

    it('shows next to a quote of a selection that is in the draft already', async () => {
        await mount();
        await act(async () => handle!.quote('the footer'));
        await reply(person);
        type('Both');

        expect(cardWords()).toBe('Use the blue one');
        expect(messageOf(draftOf(chat.id))).toBe('> the footer\n\nBoth');
    });
});

describe('sending a reply', () => {
    it('sends the quote, a blank line and what was typed, and the card is gone once it went', async () => {
        await mount();
        await reply(person);
        type('Why?');
        await pressEnter();

        expect(sent).toEqual([{ type: 'chat.send', chatId: chat.id, text: '> Use the blue one\n\nWhy?', mode: 'steer' }]);
        expect(card()).toBeNull();
        expect(replyQuoteOf(chat.id)).toBeUndefined();
        expect(editor().getText()).toBe('');
    });

    it('quotes the source Markdown of the message, a line to a line, as a quote added from a selection is written', async () => {
        await mount();
        await reply({ role: 'assistant', text: '## Done\n\n- one\n- two' });
        type('Nice');
        await act(async () => sendButton().click());

        expect(sent[0]).toMatchObject({ type: 'chat.send', text: expect.stringMatching(/^> ## Done {2}\n>[ ]{2}\n> - one {2}\n> - two\n\nNice$/) });
    });

    it('sends the words after a card that is in front of a quote of a selection', async () => {
        await mount();
        await act(async () => handle!.quote('the footer'));
        await reply(person);
        type('Both');
        await pressEnter();

        expect(sent[0]).toMatchObject({ text: '> Use the blue one\n\n> the footer\n\nBoth' });
    });

    it('cannot send a quote alone: nothing is sent, and the card and the focus stay', async () => {
        await mount();
        await reply(person);

        expect(sendButton().disabled).toBe(true);

        await pressEnter();

        expect(sent).toEqual([]);
        expect(cardWords()).toBe('Use the blue one');
    });

    it('sends a file with the quote, since the message then has something of its own', async () => {
        await mount();
        setFiles(chat.id, [readyFile('shot.txt')]);
        await reply(person);
        await act(async () => sendButton().click());

        expect(sent).toEqual([{ type: 'chat.send', chatId: chat.id, text: '> Use the blue one', attachmentIds: ['a-shot.txt'], mode: 'steer' }]);
        expect(card()).toBeNull();
    });

    it('gives the words, the files and the card back when the daemon refuses the message', async () => {
        await mount({ chat }, refused);
        setFiles(chat.id, [readyFile('shot.txt')]);
        await reply(person);
        type('Why?');
        await pressEnter();

        expect(sent).toHaveLength(1);
        expect(cardWords()).toBe('Use the blue one');
        expect(editor().getText()).toContain('Why?');
        expect(container.textContent).toContain('shot.txt');

        // And the retry sends the same.
        await pressEnter();

        expect(sent[1]).toEqual(sent[0]);
    });

    it('keeps the card for the message the person picked while the send was on its way, and gives the old one up', async () => {
        let refuse!: (result: CommandResult) => void;
        const slow = new Promise<CommandResult>((resolve) => {
            refuse = resolve;
        });

        await mount({ chat }, slow);
        await reply(person);
        type('Why?');
        await pressEnter();

        expect(card()).toBeNull();

        await reply(answer);
        await act(async () => refuse(refused));

        expect(cardWords()).toBe('The form is fixed.');
        // The words come back all the same, as nothing new was typed.
        expect(editor().getText()).toContain('Why?');
    });

    it('sends only the words once the card is removed', async () => {
        await mount();
        await reply(person);
        await act(async () => card()!.querySelector<HTMLButtonElement>('button[aria-label="Remove quote"]')!.click());
        type('Never mind');
        await pressEnter();

        expect(sent[0]).toMatchObject({ text: 'Never mind' });
    });

    it('does not carry a card to another chat\'s message', async () => {
        await mount();
        await reply(person);
        await mount({ chat: other });
        type('Elsewhere');
        await pressEnter();

        expect(sent[0]).toMatchObject({ chatId: other.id, text: 'Elsewhere' });
        expect(replyQuoteOf(chat.id)).toEqual(person);
    });
});
