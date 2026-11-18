import { docToPlainText, emptyComposerDoc, type ComposerDoc } from '@clowdy/components/RichInput';

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
