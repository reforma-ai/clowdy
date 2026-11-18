import { docToPlainText, emptyComposerDoc, type ComposerDoc } from '@clowdy/components/RichInput';

import { serializeMention } from './composerMentions';

import type { ChatId } from '@clowdy/protocol';

/** What was typed and not sent, so that moving to another chat and back does not lose it. */
const drafts = new Map<ChatId, ComposerDoc>();

export function draftOf(chatId: ChatId): ComposerDoc {
    return drafts.get(chatId) ?? emptyComposerDoc();
}

export function saveDraft(chatId: ChatId, doc: ComposerDoc): void {
    drafts.set(chatId, doc);
}

/** The words a draft sends: the document as markdown with its mentions written out, trimmed. Empty when there is nothing to send. */
export function messageOf(doc: ComposerDoc): string {
    return docToPlainText(doc, serializeMention).trim();
}
