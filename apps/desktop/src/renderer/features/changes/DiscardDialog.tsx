import { Box } from '@clowdy/components/Box';
import { openConfirmModal } from '@clowdy/components/modals';
import { Show } from '@clowdy/components/Show';
import { Text } from '@clowdy/components/Text';
import { toast } from '@clowdy/components/Toast';

import { agentsWorkingWords, discardWords } from './discardRules';
import { splitPath } from './gitSummary';

import type { GitChangedFile, GitDiscardResult } from '@clowdy/protocol';

export interface DiscardDialogOptions {
    /** The file, as the place's uncommitted list has it: what happens to it follows its state. */
    file: Pick<GitChangedFile, 'path' | 'kind' | 'untracked'>;
    /** How many chats work in the place right now: the dialog warns when any does. */
    working: number;
    /** Asks the daemon to discard the file. A rejection is shown in the dialog, which stays open; a resolution closes it, and a warning of the daemon (a hook of the person's failed after the file was back) is a toast. */
    discard: () => Promise<GitDiscardResult>;
}

/** The body of the confirmation: which file (its folder, when it has one), what happens to it, and the warning while an agent works in the place. */
export function DiscardMessage({
    file,
    body,
    working,
}: {
    file: Pick<GitChangedFile, 'path'>;
    body: string;
    working: string | undefined;
}) {
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
            <Show when={working}>
                {words => (
                    <Text variant="md" color="warning" role="note">
                        {words}
                    </Text>
                )}
            </Show>
        </Box>
    );
}

/**
 * Asks before the changes of a file are discarded, and says what happens to it: `Discard changes to <file>?` with `The file goes back to the last commit. A copy of what it holds now is kept
 * for 7 days.`, or `Delete <file>?` for a file that is not in git. The buttons are `Discard changes` (danger) and `Cancel`, and **the focus starts on Cancel**: a press of Enter on the
 * dialog does nothing, and only a press on Discard changes discards. While the daemon works both buttons are held; a failure is said in the dialog with the daemon's own line (git's, or the
 * copy's) and nothing closes, so the next press tries again; a discard that went through closes it (with a toast that has the line of the person's `post-checkout` hook when that failed after
 * the file was back). While an agent works in the place the dialog says so, as a warning and no more: the
 * daemon does not stop a chat, and the person decides.
 */
export function openDiscardDialog({ file, working, discard }: DiscardDialogOptions): void {
    const words = discardWords(file);

    openConfirmModal(
        {
            title: words.title,
            message: <DiscardMessage file={file} body={words.body} working={agentsWorkingWords(working)} />,
            confirmLabel: 'Discard changes',
            cancelLabel: 'Cancel',
            destructive: true,
            initialFocus: 'cancel',
            errorIn: 'dialog',
            onConfirm: async () => {
                const { warning } = await discard();

                // The file is discarded all the same: only the person's own hook said no after it, which the dialog's failure line would have called a failure.
                if (warning !== undefined)
                    toast.warning({ title: 'Changes discarded', message: warning, timeout: 8000 });
            },
        },
        { width: 420 }
    );
}
