import { type ComposerDoc, docToPlainText, emptyComposerDoc, plainTextToDoc } from '@clowdy/components/RichInput';
import { useSyncExternalStore } from 'react';

import { serializeMention } from './composerMentions';

import type { ChatId, ProjectId } from '@clowdy/protocol';

/** What the new-chat page's draft keys start with: there is no chat id to keep its words under yet. */
export const NEW_CHAT_DRAFT = '@new-chat';

/**
 * The key of the new-chat page of one project, for its words (`draftOf`) and its files (`composerFiles`) alike: a file belongs to the
 * project it was uploaded to, so the words that mention it stay with that project too. A started chat is keyed by its own id, which
 * is unique already.
 */
export function newChatDraftKey(projectId: ProjectId | undefined): string {
    return `${NEW_CHAT_DRAFT}:${projectId ?? ''}`;
}

/**
 * The key of the edit session of one message, for its words (`draftOf`) and its files (`composerFiles`) alike: the box in the edit frame is a composer of its own,
 * and under the chat's own key it would share the chat's draft and files with the box at the bottom. The session ends with its key, so it never reaches
 * the chat's draft.
 */
export function editDraftKey(chatId: ChatId, itemId: string): string {
    return `edit:${chatId}:${itemId}`;
}

/** What was typed and not sent, so that moving to another chat and back does not lose it. Keyed by a chat's id, `newChatDraftKey` or `editDraftKey`. */
const drafts = new Map<string, ComposerDoc>();
const listeners = new Set<() => void>();
let revision = 0;

function changed() {
    revision++;
    listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
}

export function useDraftRevision() {
    return useSyncExternalStore(subscribe, () => revision);
}

export function draftOf(key: string): ComposerDoc {
    return drafts.get(key) ?? emptyComposerDoc();
}

export function saveDraft(key: string, doc: ComposerDoc): void {
    const wasDirty = messageOf(draftOf(key)) !== '';
    drafts.set(key, doc);
    if (wasDirty !== (messageOf(doc) !== '')) changed();
}

/** Forgets a draft: an edit session that has ended leaves nothing behind. */
export function dropDraft(key: string): void {
    const wasDirty = messageOf(draftOf(key)) !== '';
    drafts.delete(key);
    if (wasDirty) changed();
}

/** The words a draft sends: the document as markdown with its mentions written out, trimmed. Empty when there is nothing to send. */
export function messageOf(doc: ComposerDoc): string {
    return docToPlainText(doc, serializeMention).trim();
}

/**
 * The document that holds a sent message's words, for editing it: a paragraph for each run of text between blank lines, as the message box writes what is
 * typed (Shift+Enter makes a paragraph, which `messageOf` joins with a blank line), and a line break for a single newline inside one. The two spaces that
 * end a line to break it in Markdown are left off, since `messageOf` writes them again: the words of a message that was not changed come back as they were
 * sent, except that the lines of a list or a fence, which the box has no node for, end with that line break, as a queued message's words do. An empty
 * message gives an empty draft.
 */
export function docOfMessage(text: string): ComposerDoc {
    const paragraphs = text
        .replaceAll(/\r\n?/g, '\n')
        .trim()
        .split(/\n(?:[ \t]*\n)+/)
        .filter(paragraph => paragraph !== '');

    if (paragraphs.length === 0) return emptyComposerDoc();

    return {
        type: 'doc',
        content: paragraphs.flatMap(paragraph => plainTextToDoc(paragraph.replaceAll(/[ \t]+\n/g, '\n')).content ?? []),
    };
}

/**
 * The draft with `text` in front: alone in an empty draft, and as a paragraph of its own before the words of one that has them, since it was written
 * first (a queued message the person takes back to edit).
 */
export function withTextFirst(draft: ComposerDoc, text: string): ComposerDoc {
    if (!text) return draft;

    if (messageOf(draft) === '') return plainTextToDoc(text);

    return { ...draft, content: [...(plainTextToDoc(text).content ?? []), ...(draft.content ?? [])] };
}

/** For each line, whether it is a part of a fenced code block, its fences included: what a block holds is code, and a blank line in it is a line of the code. */
function fencedLines(lines: readonly string[]): boolean[] {
    let open = '';

    return lines.map(line => {
        const [, fence = '', rest = ''] = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line) ?? [];

        if (!open) {
            // An info string of a backtick fence holds no backtick: ```a``` is a span of code.
            if (!fence || (fence.startsWith('`') && rest.includes('`'))) return false;

            open = fence;

            return true;
        }

        // A fence of the same mark, at least as long, with nothing after it, closes the block.
        if (fence.startsWith(open[0]!) && fence.length >= open.length && rest.trim() === '') open = '';

        return true;
    });
}

/**
 * The text inside an editable quote. Keep blank lines inside fenced code, and omit the empty lines separating consecutive Markdown quotes.
 */
function quoteOf(text: string): string {
    const lines = text.replaceAll(/\r\n?/g, '\n').split('\n');
    const fenced = fencedLines(lines);
    const kept = lines.filter(
        (line, index) =>
            fenced[index] ||
            !(line.trim() === '' && lines[index - 1]?.startsWith('>') && lines[index + 1]?.startsWith('>'))
    );
    return kept.join('\n').trim();
}

/**
 * Append a quote block and a separate paragraph for the reply. Hard breaks keep the quoted lines together when serialized to Markdown.
 */
export function withQuoteLast(draft: ComposerDoc, text: string): ComposerDoc {
    const quote = quoteOf(text);

    if (!quote) return draft;

    const blocks = messageOf(draft) === '' ? [] : (draft.content ?? []);
    const kept = blocks.slice(
        0,
        blocks.findLastIndex(block => block.type !== 'paragraph' || block.content?.length) + 1
    );

    return {
        ...draft,
        content: [...kept, { ...plainTextToDoc(quote).content?.[0], type: 'composerQuote' }, { type: 'paragraph' }],
    };
}

/**
 * The message a box sends when it replies to another: the quote of `quoted`, written as `withQuoteLast` writes it in a draft (so a quote that was added with a
 * selection and one that is a card read alike), a blank line, then `message`, which is what is typed. The blank line keeps the words out of the quote (text
 * right under it would be a lazy continuation, one blockquote). Without words it is the quote alone; a quote of nothing leaves the words as they are.
 */
export function quotedMessage(quoted: string, message: string): string {
    const quote = messageOf(withQuoteLast(emptyComposerDoc(), quoted));

    if (!quote) return message;

    return message ? `${quote}\n\n${message}` : quote;
}
