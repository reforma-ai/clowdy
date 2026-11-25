import { Box } from '@clowdy/components/Box';
import { openConfirmModal } from '@clowdy/components/modals';
import { Show } from '@clowdy/components/Show';
import { Text } from '@clowdy/components/Text';
import { toast } from '@clowdy/components/Toast';

import { discardWords } from './discardRules';
import { splitPath } from './gitSummary';

import type { GitChangedFile, GitDiscardResult } from '@clowdy/protocol';

export interface DiscardDialogOptions {
    /** The file, as the place's uncommitted list has it: what happens to it follows its state. */
    file: Pick<GitChangedFile, 'path' | 'kind' | 'untracked'>;
    /** Asks the daemon to discard the file. A rejection is shown in the dialog, which stays open; a resolution closes it, and a warning of the daemon (a hook of the person's failed after the file was back) is a toast. */
    discard: () => Promise<GitDiscardResult>;
}

/** The body of the confirmation: which file, and what happens to it. */
export function DiscardMessage({ file, body }: { file: Pick<GitChangedFile, 'path'>; body: string }) {
    const { folder } = splitPath(file.path);

    return (
        <Box gap="sm">
            <Show when={folder}>
                <Text variant="sm" color="secondary" truncate title={file.path}>
                    {file.path}
                </Text>
            </Show>
            <Text variant="md" color="secondary">
                {body}
            </Text>
        </Box>
    );
}

/** Confirms the selected file, starting on Cancel. Failures stay in the dialog; a completed discard gets a short toast. */
export function openDiscardDialog({ file, discard }: DiscardDialogOptions): void {
    const words = discardWords(file);
    const { name } = splitPath(file.path);

    openConfirmModal(
        {
            title: words.title,
            message: <DiscardMessage file={file} body={words.body} />,
            confirmLabel: 'Discard changes',
            cancelLabel: 'Cancel',
            cancelVariant: 'filled',
            destructive: true,
            initialFocus: 'cancel',
            errorIn: 'dialog',
            onConfirm: async () => {
                const { warning } = await discard();

                // The file is discarded all the same: only the person's own hook said no after it, which the dialog's failure line would have called a failure.
                if (warning !== undefined)
                    toast.warning({ title: `${name} discarded`, message: warning, timeout: 8000 });
                else toast.success({ message: `${name} discarded` });
            },
        },
        { width: 420 }
    );
}
