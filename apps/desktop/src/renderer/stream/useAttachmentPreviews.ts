import { use, useEffect, useState } from 'react';

import { isPicture } from '../shared/pictures';
import { StreamLinksContext } from './StreamLinks';

import type { Attachment } from '@clowdy/protocol';

/**
 * The pictures among a message's files as `blob:` URLs by attachment id, fetched when the message shows and let go of when it
 * goes. A file that cannot be fetched, or is not a picture, has no entry and shows as its icon.
 */
export function useAttachmentPreviews(attachments: readonly Attachment[] | undefined): ReadonlyMap<string, string> {
    const { attachmentBlob } = use(StreamLinksContext);
    const [previews, setPreviews] = useState<ReadonlyMap<string, string>>(new Map());

    useEffect(() => {
        const pictures = (attachments ?? []).filter(attachment => isPicture(attachment.mediaType));

        if (!attachmentBlob || pictures.length === 0) return;

        let gone = false;
        const urls: string[] = [];

        for (const attachment of pictures) {
            attachmentBlob(attachment).then(
                blob => {
                    if (gone) return;

                    // The daemon answers with a neutral type; the picture is shown as what the message says it is.
                    const url = URL.createObjectURL(new Blob([blob], { type: attachment.mediaType }));

                    urls.push(url);
                    setPreviews(current => new Map(current).set(attachment.id, url));
                },
                () => undefined
            );
        }

        return () => {
            gone = true;
            urls.forEach(url => URL.revokeObjectURL(url));
            setPreviews(new Map());
        };
    }, [attachments, attachmentBlob]);

    return previews;
}
