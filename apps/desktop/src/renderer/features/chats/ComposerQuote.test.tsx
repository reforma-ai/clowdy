// @vitest-environment happy-dom
import { docToPlainText, emptyComposerDoc } from '@clowdy/components/RichInput';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RootStoreProvider, type RootStore } from '../../stores';
import { UserBubble } from '../../stream/UserBubble';
import { Composer, type ComposerHandle } from './Composer';
import { draftOf, messageOf, newChatDraftKey, saveDraft } from './composerDrafts';
import { modelStore } from './modelTestKit';

import type { Chat } from '@clowdy/protocol';
import type { Editor } from '@tiptap/core';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Reply from a message: `ComposerHandle.quote` adds the quote to the end of this chat's draft, in the real editor, and puts the caret in an empty paragraph
 * under it, so what is typed there is sent after a blank line and is not a part of the quote.
 */

const transport = {
    getDocsTree: vi.fn(async () => []),
    getProjectFiles: vi.fn(async () => []),
    getSkills: vi.fn(async () => ({ entries: [], tokens: 0, warnings: [] })),
};

let container: HTMLDivElement;
let root: Root;
let handle: ComposerHandle | null;
// Drafts are remembered per chat for the whole session, so each test gets a chat of its own.
let chat: Chat;
let chatNumber = 0;

async function mount(props: { chat?: Chat; projectId?: string } = { chat }) {
    const store = { command: vi.fn(async () => ({ ok: true, requestId: 'request-1', data: {} })), transport, skillsRevision: 0, selectedProject: { project: { id: 'p' }, taskList: [] }, ...await modelStore() };

    await act(async () => {
        root.render(
            <RootStoreProvider value={ store as unknown as RootStore }>
                <Composer
                    ref={ (value) => {
                        handle = value;
                    } }
                    chat={ props.chat }
                    run={ undefined }
                    start={ props.projectId ? { projectId: props.projectId, onStarted: () => undefined } : undefined }
                />
            </RootStoreProvider>
        );
    });
}

const field = () => container.querySelector<HTMLElement>('[contenteditable="true"]')!;
const editor = () => (field() as HTMLElement & { editor: Editor }).editor;
/** What the field holds, as it would be sent, with a hard break shown as the newline it is. */
const written = () => docToPlainText(editor().getJSON()).replaceAll('  \n', '\n');
const quote = (text: string) => act(async () => handle!.quote(text));
const atEnd = () => editor().state.selection.empty && editor().state.selection.from === editor().state.doc.content.size - 1;
/** The text of the paragraph the caret is in: empty for the line under a quote. */
const caretLine = () => editor().state.selection.$from.parent.textContent;
/** What the message box would send, and what the stream then draws for it: the same Markdown as a message the person wrote. */
const sent = () => messageOf(editor().getJSON());
const drawn = (text: string) => renderToStaticMarkup(<UserBubble text={ text } at={ 0 } />);

function type(value: string) {
    act(() => {
        editor().commands.insertContent(value);
    });
}

beforeEach(() => {
    // A chat that has run does not take the focus when it is drawn, as the new-chat page does.
    chat = { id: `c-${ ++chatNumber }`, projectId: 'p', title: 'New chat', mode: 'autopilot', orchestratorRunId: 'r-1', createdAt: 0, updatedAt: 0 };
    handle = null;
    saveDraft(newChatDraftKey('p'), emptyComposerDoc());
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('ComposerHandle.quote', () => {
    it('puts the quote in the field and in the draft of the chat', async () => {
        await mount();
        await quote('Use the blue one');

        expect(written()).toBe('> Use the blue one\n\n');
        expect(docToPlainText(draftOf(chat.id)).replaceAll('  \n', '\n')).toBe('> Use the blue one\n\n');
    });

    it('focuses the field with the caret at the end, on the line under the quote', async () => {
        await mount();

        expect(document.activeElement).not.toBe(field());

        await quote('one\ntwo');

        expect(document.activeElement).toBe(field());
        expect(atEnd()).toBe(true);
        expect(caretLine()).toBe('');
    });

    it('sends the quote alone when nothing is typed under it, with no blank line left over', async () => {
        await mount();
        await quote('Use the blue one');

        expect(sent()).toBe('> Use the blue one');
    });

    it('sends what the person types next after a blank line, so it is not a part of the quote', async () => {
        await mount();
        await quote('Use the blue one');
        type('Why?');

        expect(sent()).toBe('> Use the blue one\n\nWhy?');
        expect(caretLine()).toBe('Why?');
    });

    it('draws the sent text as a quote and a reply after it, not as one quote with the reply in it', async () => {
        await mount();
        await quote('Use the blue one');
        type('Why?');

        const out = drawn(sent());

        // The reply is outside the blockquote; it was inside it when it followed the quote on the very next line.
        expect(out.match(/<blockquote/g)).toHaveLength(1);
        expect(out.slice(out.indexOf('</blockquote>'))).toContain('Why?');
        expect(out.slice(0, out.indexOf('</blockquote>'))).not.toContain('Why?');
    });

    it('adds the quote after the words that are there, and the caret goes to the end though it was at the start', async () => {
        await mount();
        type('Please look');
        act(() => {
            editor().commands.setTextSelection(1);
        });
        await quote('the footer');

        expect(written()).toBe('Please look\n\n> the footer\n\n');
        expect(atEnd()).toBe(true);

        type('Is it fixed?');

        expect(sent()).toBe('Please look\n\n> the footer\n\nIs it fixed?');
    });

    it('stacks a second quote under the first, with a blank line between, and keeps the caret at the end', async () => {
        await mount();
        await quote('first');
        await quote('second');

        expect(written()).toBe('> first\n\n> second\n\n');
        expect(atEnd()).toBe(true);
        expect(caretLine()).toBe('');

        type('Both');

        expect(sent()).toBe('> first\n\n> second\n\nBoth');
        expect(drawn(sent()).match(/<blockquote/g)).toHaveLength(2);
    });

    it('quotes after a reply that is typed under an earlier quote', async () => {
        await mount();
        await quote('first');
        type('Yes');
        await quote('second');

        expect(sent()).toBe('> first\n\nYes\n\n> second');
        expect(atEnd()).toBe(true);
    });

    it('quotes into the draft of the chat that is open, not of another', async () => {
        const other = `c-other-${ chatNumber }`;

        await mount();
        await quote('here');

        expect(docToPlainText(draftOf(other))).toBe('');
    });

    it('does nothing for a quote of blanks: the draft stays and the field is not focused', async () => {
        await mount();
        type('words');
        act(() => field().blur());
        await quote('  \n ');

        expect(written()).toBe('words');
        expect(document.activeElement).not.toBe(field());
    });

    it('works on the new-chat page, into the draft of its project', async () => {
        await mount({ projectId: 'p' });
        act(() => field().blur());
        await quote('A line to build on');

        expect(written()).toBe('> A line to build on\n\n');
        expect(docToPlainText(draftOf(newChatDraftKey('p'))).replaceAll('  \n', '\n')).toBe('> A line to build on\n\n');
        expect(document.activeElement).toBe(field());
        expect(atEnd()).toBe(true);
    });
});
