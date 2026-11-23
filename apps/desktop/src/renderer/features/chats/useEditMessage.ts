import { toast } from '@clowdy/components/Toast';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useRootStore } from '../../stores';
import { editDraftKey } from './composerDrafts';
import { beginEditSession, endEditSession } from './editSession';

import type { Attachment, Chat, ProjectId, StreamItem } from '@clowdy/protocol';
import type { RootStore } from '../../stores';

/** What lets go of a file uploaded for an edit that did not go through: nobody will send it, so the daemon need not keep it. */
const deleteUnsent = (root: RootStore, projectId: ProjectId) => (attachment: Attachment) =>
    void root.transport.deleteAttachment(projectId, attachment.id).catch(() => undefined);

export interface EditMessageOptions {
    chat: Chat;
    /** The chat's stream: the message to edit is one of these, and the edit is over when it is not any more. */
    items: readonly StreamItem[];
    /** The stream is loaded: only then can a message that is not in `items` be told to have gone, rather than not to have come yet. */
    ready: boolean;
    /** The chat can be written to: a chat that stops being so (its agent was signed out) closes the editor. */
    writable: boolean;
    /** The bytes of a file the message carries, for the previews in the editor. */
    attachmentBlob?: (attachment: Attachment) => Promise<Blob>;
}

/**
 * Editing a message of the person's in place, for a chat: one session at a time. `begin(itemId)` opens the editor on a message with `canEdit`, seeding
 * its own words and files (`editSession`, under `editDraftKey`, never the chat's draft); `submit` sends `chat.edit` and `cancel` ends the session with
 * nothing sent. A refusal is a toast with the daemon's words and the editor stays open with what is in it; a success closes it, and the cut itself comes
 * through the stream (`stream.truncated`). A message that goes while the editor is open (someone else's edit or fork cut it, a resync) closes it with a
 * toast, unless the edit being sent is what removed it. Leaving the chat ends the session, and with it what the editor uploaded and nobody sent, unless an
 * edit is on its way. There is no cancel while an edit is on its way: its files are being used.
 */
export function useEditMessage({ chat, items, ready, writable, attachmentBlob }: EditMessageOptions) {
    const root = useRootStore();
    const projectId = chat.projectId;
    const [itemId, setItemId] = useState<string>();
    const [pending, setPending] = useState(false);
    // The key of the open session. Read by what ends the session from outside the render, and by a second press made before the state has drawn.
    const open = useRef<string | undefined>(undefined);
    const busy = useRef(false);

    /** Ends the session. `keepFiles` when the daemon has the files to use: the edit went through, or is on its way and would be refused one that was deleted. */
    const close = useCallback(
        (keepFiles = false) => {
            if (open.current === undefined) return;

            endEditSession(open.current, keepFiles ? undefined : deleteUnsent(root, projectId));
            open.current = undefined;
            setItemId(undefined);
        },
        [root, projectId]
    );

    // Leaving the chat takes the session with it, and nobody is left to send the files uploaded for it, unless an edit is on its way.
    useEffect(() => () => close(busy.current), [close]);

    const present = itemId !== undefined && items.some(item => item.id === itemId && item.canEdit);
    const lost = itemId !== undefined && !pending && (!writable || (ready && !present));

    useEffect(() => {
        if (!lost) return;

        if (writable) toast.warning({ message: 'The message is no longer available' });

        close();
    }, [lost, writable, close]);

    const begin = (id: string) => {
        const item = items.find(candidate => candidate.id === id);

        if (open.current !== undefined || item?.body.kind !== 'user' || !item.canEdit) return;

        const key = editDraftKey(chat.id, id);

        beginEditSession(key, item.body, attachmentBlob);
        open.current = key;
        setItemId(id);
    };

    const cancel = () => {
        if (!busy.current) close();
    };

    const submit = async ({ text, attachmentIds }: { text: string; attachmentIds: string[] }) => {
        if (itemId === undefined || busy.current) return;

        busy.current = true;
        setPending(true);

        try {
            const result = await root.command({
                type: 'chat.edit',
                chatId: chat.id,
                itemId,
                text,
                ...(attachmentIds.length > 0 && { attachmentIds }),
            });

            if (result.ok) close(true);
            else toast.error({ message: result.error.message || "Couldn't edit the message" });
        } finally {
            busy.current = false;
            setPending(false);
        }
    };

    return {
        /** The open session, while there is one: the message being edited and the key of its own draft and files. */
        session: itemId === undefined ? undefined : { itemId, draftKey: editDraftKey(chat.id, itemId) },
        /** `chat.edit` is on its way. */
        pending,
        begin,
        cancel,
        submit,
    };
}
