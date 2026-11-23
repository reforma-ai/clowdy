import { isPicture } from '../../shared/pictures';
import { docOfMessage, dropDraft, saveDraft } from './composerDrafts';
import { type DraftFile, filesOf, patchFile, releaseFiles, setFiles, takeFiles } from './composerFiles';

import type { Attachment } from '@clowdy/protocol';

/** What an edit session starts from: a message the person sent. */
export interface EditedMessage {
    text: string;
    attachments?: readonly Attachment[];
}

/**
 * Opens the edit session of a message under `key` (`editDraftKey`): its words are the session's draft and its files are in the box as uploaded cards, the
 * way a queued message comes back when it is edited, marked as sent so that taking one off never deletes the daemon's copy (the message still has it until
 * an edit goes through). What an earlier session left under the same key is let go of first. The pictures among the files get their preview from
 * `attachmentBlob` once it answers, unless the session has ended by then.
 */
export function beginEditSession(
    key: string,
    message: EditedMessage,
    attachmentBlob?: (attachment: Attachment) => Promise<Blob>
): void {
    releaseFiles(takeFiles(key));
    saveDraft(key, docOfMessage(message.text));

    const files = (message.attachments ?? []).map(
        (attachment): DraftFile => ({
            key: crypto.randomUUID(),
            name: attachment.name,
            mediaType: attachment.mediaType,
            size: attachment.size,
            status: 'ready',
            attachment,
            sent: true,
        })
    );

    setFiles(key, files);

    if (!attachmentBlob) return;

    for (const file of files.filter(candidate => isPicture(candidate.mediaType))) {
        attachmentBlob(file.attachment!).then(
            blob => {
                // The card was taken off, or the session is over: nobody would let go of the URL.
                if (!filesOf(key).some(held => held.key === file.key)) return;

                // The daemon answers with a neutral type; the picture is shown as what the message says it is.
                patchFile(key, file.key, { preview: URL.createObjectURL(new Blob([blob], { type: file.mediaType })) });
            },
            () => undefined
        );
    }
}

/**
 * Ends the session under `key`: the draft is forgotten and the files are let go of (their previews). `discard` is called with each file that was uploaded
 * during the session and was not sent with a message, which the caller deletes from the daemon when the edit did not go through; the files of the
 * message itself are never offered, since it still has them. A session whose edit went through passes none: the daemon keeps what the edit named.
 */
export function endEditSession(key: string, discard?: (attachment: Attachment) => void): void {
    dropDraft(key);

    const files = takeFiles(key);

    releaseFiles(files);

    for (const file of files) {
        if (file.attachment && !file.sent) discard?.(file.attachment);
    }
}
