import { toast } from '@clowdy/components/Toast';
import { useCallback } from 'react';

import { useRootStore } from '../../stores';
import { admitFiles, draftFileOf, filesOf, patchFile, releaseFiles, setFiles, useDraftFiles } from './composerFiles';

import type { ProjectId } from '@clowdy/protocol';

/**
 * The files of one message box: picking, uploading at once, trying again, taking one off. The uploads outlive the component
 * (the person may go to another chat meanwhile), so they write to the stored draft, not to state.
 */
export function useComposerFiles(key: string, projectId: ProjectId | undefined) {
    const { transport } = useRootStore();
    const files = useDraftFiles(key);

    const upload = useCallback(
        async (fileKey: string, source: File) => {
            if (!projectId) return;

            try {
                const attachment = await transport.uploadAttachment(projectId, source);

                // Taken off while it was going up: nobody will send it, so the daemon need not keep it.
                if (!patchFile(key, fileKey, { status: 'ready', error: undefined, attachment }))
                    void transport.deleteAttachment(projectId, attachment.id).catch(() => undefined);
            } catch (error) {
                const reason = error instanceof Error ? error.message : 'The file could not be uploaded';

                if (patchFile(key, fileKey, { status: 'error', error: reason }))
                    toast.error({ title: `${source.name} was not uploaded`, message: reason });
            }
        },
        [transport, projectId, key]
    );

    const add = useCallback(
        (incoming: readonly File[]) => {
            const { accepted, refusals } = admitFiles(filesOf(key), incoming);

            for (const message of refusals) toast.warning({ title: 'File not attached', message });

            const added = accepted.map(draftFileOf);

            if (added.length === 0) return;

            setFiles(key, [...filesOf(key), ...added]);

            for (const file of added) void upload(file.key, file.source!);
        },
        [key, upload]
    );

    const remove = useCallback(
        (fileKey: string) => {
            const gone = filesOf(key).find(file => file.key === fileKey);

            if (!gone) return;

            setFiles(
                key,
                filesOf(key).filter(file => file.key !== fileKey)
            );
            releaseFiles([gone]);

            // A file of a message that was sent stays with that message, which is still there until an edit goes through.
            if (gone.attachment && !gone.sent && projectId)
                void transport.deleteAttachment(projectId, gone.attachment.id).catch(() => undefined);
        },
        [key, projectId, transport]
    );

    const retry = useCallback(
        (fileKey: string) => {
            const file = filesOf(key).find(candidate => candidate.key === fileKey);

            if (!file?.source) return;

            patchFile(key, fileKey, { status: 'uploading', error: undefined });
            void upload(fileKey, file.source);
        },
        [key, upload]
    );

    return {
        files,
        add,
        remove,
        retry,
        /** Something is still going up: the message waits for it. */
        uploading: files.some(file => file.status === 'uploading'),
        /** Something did not go up: the person takes it off or tries again before sending. */
        failed: files.some(file => file.status === 'error'),
    };
}
