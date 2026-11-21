import { docToPlainText, emptyComposerDoc, plainTextToDoc, type ComposerDoc } from '@clowdy/components/RichInput';

import { serializeMention } from './composerMentions';

import type { ProjectId } from '@clowdy/protocol';

/** What the new-chat page's draft keys start with: there is no chat id to keep its words under yet. */
export const NEW_CHAT_DRAFT = '@new-chat';

/**
 * The key of the new-chat page of one project, for its words (`draftOf`) and its files (`composerFiles`) alike: a file belongs to the
 * project it was uploaded to, so the words that mention it stay with that project too. A started chat is keyed by its own id, which
 * is unique already.
 */
export function newChatDraftKey(projectId: ProjectId | undefined): string {
    return `${ NEW_CHAT_DRAFT }:${ projectId ?? '' }`;
}

/** What was typed and not sent, so that moving to another chat and back does not lose it. Keyed by a chat's id or `newChatDraftKey`. */
const drafts = new Map<string, ComposerDoc>();

export function draftOf(key: string): ComposerDoc {
    return drafts.get(key) ?? emptyComposerDoc();
}

export function saveDraft(key: string, doc: ComposerDoc): void {
    drafts.set(key, doc);
}

/** The words a draft sends: the document as markdown with its mentions written out, trimmed. Empty when there is nothing to send. */
export function messageOf(doc: ComposerDoc): string {
    return docToPlainText(doc, serializeMention).trim();
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

/**
 * The quote a piece of text makes: `> ` before every line and a bare `>` for a blank one, with the blank lines between two lines that are quotes
 * already left out, trimmed. Empty when there is nothing to quote.
 */
function quoteOf(text: string): string {
    const lines = text.replaceAll(/\r\n?/g, '\n').split('\n');
    const kept = lines.filter((line, index) => !(line.trim() === '' && lines[index - 1]?.startsWith('>') && lines[index + 1]?.startsWith('>')));
    const trimmed = kept.join('\n').trim();

    if (trimmed === '') return '';

    return trimmed.split('\n').map(line => (line.trim() === '' ? '>' : `> ${ line }`)).join('\n');
}

/**
 * The draft with a quote of `text` at its end, for Reply: a paragraph of its own, after a blank line from the words, the quote or the list that are there
 * (as the hand-off's sentence is), then an empty paragraph for the caret. What is typed there is sent under the quote after a blank line, `> quote`,
 * blank, reply: text right under a quote would be a lazy continuation of it in Markdown, one blockquote. A quote with nothing typed after it is sent
 * as the quote alone, since the message is trimmed. Empty paragraphs that ended the draft are replaced, so quotes do not pile up blank lines. The
 * lines of the quote are hard breaks inside its paragraph, as `plainTextToDoc` writes them (a paragraph per line would send blank lines between them,
 * which cut one quote into several); the `>` is plain text, there is no quote node in the message box. Nothing to quote gives the draft back as it is.
 */
export function withQuoteLast(draft: ComposerDoc, text: string): ComposerDoc {
    const quote = quoteOf(text);

    if (!quote) return draft;

    const blocks = messageOf(draft) === '' ? [] : draft.content ?? [];
    const kept = blocks.slice(0, blocks.findLastIndex(block => block.type !== 'paragraph' || block.content?.length) + 1);

    return { ...draft, content: [...kept, ...(plainTextToDoc(quote).content ?? []), { type: 'paragraph' }] };
}
