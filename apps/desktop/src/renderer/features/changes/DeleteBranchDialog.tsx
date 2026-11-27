import { Alert, AlertDescription, AlertIcon } from '@clowdy/components/Alert';
import { Box } from '@clowdy/components/Box';
import { Checkbox } from '@clowdy/components/Checkbox';
import { openConfirmModal } from '@clowdy/components/modals';
import { Text } from '@clowdy/components/Text';
import { toast } from '@clowdy/components/Toast';
import { AttentionCircle } from '@clowdy/icons/14';
import { errorMessage } from '@clowdy/lib';
import { useState } from 'react';

import { gitFactsOf, placeRef } from './gitFacts';

import type { GitBranchDeletePreview } from '@clowdy/protocol';
import type { Transport } from '../../daemon/transport';
import type { BranchSwitch } from './BranchSwitch';

interface DeleteChoice {
    origin: boolean;
}

function DeleteMessage({ preview, choice }: { preview: GitBranchDeletePreview; choice: DeleteChoice }) {
    const [origin, setOrigin] = useState(choice.origin);
    const { localCommit, localUnmerged, originCommit, originUnmerged, switchTo } = preview;

    return (
        <Box gap="lg">
            {localCommit ? (
                <Text color="secondary" variant="md">
                    {switchTo ? `Switch to ${switchTo} and delete the local branch` : 'Delete the local branch'}
                </Text>
            ) : (
                <Text color="secondary" variant="md">
                    This deletes the branch on origin for everyone using the repository
                </Text>
            )}
            {localUnmerged && (
                <Alert color="warning" role="status">
                    <AlertIcon>
                        <AttentionCircle />
                    </AlertIcon>
                    <AlertDescription>
                        The local branch has commits that are not merged into the base branch
                    </AlertDescription>
                </Alert>
            )}
            {localCommit && originCommit && (
                <Checkbox
                    size="sm"
                    isSelected={origin}
                    onChange={value => {
                        choice.origin = value;
                        setOrigin(value);
                    }}
                >
                    Delete on origin
                </Checkbox>
            )}
            {origin && originUnmerged && (
                <Alert color="warning" role="status">
                    <AlertIcon>
                        <AttentionCircle />
                    </AlertIcon>
                    <AlertDescription>
                        The branch on origin has commits that are not merged into the base branch
                    </AlertDescription>
                </Alert>
            )}
        </Box>
    );
}

/** Confirm precisely the branch and tips that the daemon inspected. Reopen after any refusal to get a fresh preview. */
export async function openDeleteBranch(
    model: BranchSwitch,
    transport: Transport,
    branch: string,
    remote: boolean,
    isCurrent: () => boolean
): Promise<void> {
    const { key } = model.facts;
    const place = placeRef(key);
    const display = remote ? `origin/${branch}` : branch;
    const failure = (error: unknown) =>
        toast.error({ title: "Couldn't delete the branch", message: errorMessage(error) });

    try {
        const preview = await transport.deleteGitBranch(key.projectId, place, {
            action: 'preview',
            branch,
            ...(remote && { remote: true }),
        });
        if (!isCurrent()) return;

        if (preview.state !== 'preview' || preview.branch !== branch) throw new Error("Couldn't inspect the branch");
        if (preview.blocked) throw new Error(preview.blocked);
        if (remote ? preview.localCommit || !preview.originCommit : !preview.localCommit)
            throw new Error("Couldn't inspect the branch");
        if (model.busy) throw new Error('A branch operation is running');

        const choice = { origin: remote };
        openConfirmModal(
            {
                title: `Delete ${display}?`,
                message: <DeleteMessage preview={preview} choice={choice} />,
                confirmLabel: 'Delete branch',
                cancelVariant: 'filled',
                destructive: true,
                initialFocus: 'cancel',
                onConfirm: async () => {
                    try {
                        if (model.busy) throw new Error('A branch operation is running');
                        const result = await model.around(undefined, () =>
                            transport.deleteGitBranch(key.projectId, place, {
                                action: 'delete',
                                branch,
                                ...(preview.localCommit && { localCommit: preview.localCommit }),
                                ...(preview.localCommit && preview.localUnmerged && { localUnmerged: true }),
                                ...(choice.origin && preview.originCommit && { originCommit: preview.originCommit }),
                                ...(choice.origin &&
                                    preview.originCommit &&
                                    preview.originUnmerged && {
                                        originUnmerged: true,
                                    }),
                                ...(preview.switchTo && { switchTo: preview.switchTo }),
                            })
                        );
                        if (result.state !== 'done') throw new Error("Couldn't delete the branch");
                        if (result.warning) toast.warning({ message: result.warning });
                        else toast.success({ message: `Deleted ${display}` });
                    } catch (error) {
                        failure(error);
                    } finally {
                        gitFactsOf(transport).refreshFolder(key);
                        void model.load();
                    }
                },
            },
            { width: 440 }
        );
    } catch (error) {
        if (!isCurrent()) return;
        failure(error);
        void model.load();
    }
}
