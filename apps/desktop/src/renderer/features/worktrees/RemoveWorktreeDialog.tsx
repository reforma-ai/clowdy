import { Box } from '@clowdy/components/Box';
import { Checkbox } from '@clowdy/components/Checkbox';
import { For } from '@clowdy/components/For';
import { openConfirmModal } from '@clowdy/components/modals';
import { Show } from '@clowdy/components/Show';
import { Badge } from '@clowdy/components/Tag';
import { Text } from '@clowdy/components/Text';
import { useState } from 'react';

import { PathText } from '../../shared/PathText';
import { worktreeLabel } from '../agents/workspaceChoice';
import { branchWarning, removalPlan, STRANDED_WARNING } from './worktreeView';

import type { FolderWorktrees, ProjectId, WorktreeInfo } from '@clowdy/protocol';
import type { RootStore } from '../../stores';
import type { RemovalPlan } from './worktreeView';

export interface RemoveWorktreeOptions {
    root: RootStore;
    projectId: ProjectId;
    /** The folder the worktree is a checkout of. */
    group: Pick<FolderWorktrees, 'folderId'>;
    worktree: WorktreeInfo;
    /** Reads the list again, once the command has answered: the removed row goes, and a refusal usually means the row changed under the person's hands. */
    reload: () => Promise<void>;
}

/** What the person chose in the confirmation besides removing: it is read when the button is pressed. */
interface RemoveChoice {
    deleteBranch: boolean;
}

interface RemoveMessageProps {
    worktree: WorktreeInfo;
    plan: RemovalPlan;
    choice: RemoveChoice;
}

/**
 * The body of the confirmation: which worktree (its branch or commit, and its path), what goes with it, and the branch as a choice of its own. The box starts ticked only for a
 * branch whose work is in the base; one that is not carries `Not merged` and the reason it is lost with the branch. A detached HEAD has no branch to offer, and when its commits
 * are in no branch (not merged) it says they are lost with the worktree.
 */
function RemoveMessage({ worktree, plan, choice }: RemoveMessageProps) {
    const [deleteBranch, setDeleteBranch] = useState(choice.deleteBranch);
    const warning = plan.branch && branchWarning(plan.branch);

    return (
        <Box gap="lg">
            <Box gap="xxs">
                <Text weight="medium" truncate>{ worktreeLabel(worktree) }</Text>
                <PathText path={ worktree.path } variant="sm" color="secondary" />
            </Box>

            <Box gap="xs">
                <For each={ plan.notes }>
                    {note => <Text key={ note } variant="md" color="secondary">{ note }</Text>}
                </For>
            </Box>

            <Show when={ plan.branch }>
                {branch => (
                    <Box gap="xs">
                        <Box direction="row" align="center" gap="md">
                            <Checkbox
                                size="sm"
                                isSelected={ deleteBranch }
                                onChange={ (selected) => {
                                    choice.deleteBranch = selected;
                                    setDeleteBranch(selected);
                                } }
                            >
                                { `Delete branch ${ branch.name }` }
                            </Checkbox>
                            <Show when={ branch.standing === 'unmerged' }>
                                <Badge size="xs" color="warning" textValue="Not merged">Not merged</Badge>
                            </Show>
                        </Box>
                        <Show when={ warning }>
                            { text => <Text variant="sm" color="warning">{ text }</Text> }
                        </Show>
                    </Box>
                )}
            </Show>

            <Show when={ plan.stranded }>
                <Box direction="row" align="center" gap="md">
                    <Badge size="xs" color="warning" textValue="Not merged">Not merged</Badge>
                    <Text variant="sm" color="warning">{ STRANDED_WARNING }</Text>
                </Box>
            </Show>
        </Box>
    );
}

/**
 * Asks before a worktree of the Manage dialog is removed, and sends `workspace.remove`. The words follow the worktree: a plain confirm when nothing in it is uncommitted; a red
 * `Discard N changes and remove` (it sends `discard: true`) when something is, a new file or an initialised submodule included; `Remove record` when its folder is gone. The
 * branch is a box of its own (`deleteBranch`), whatever the branch is called, ticked from the start only when its work is in the base. Cancelling sends nothing. The list is
 * read again once the daemon has answered, and a refusal shows the daemon's own reason while the confirmation stays open.
 */
export function openRemoveWorktree({ root, projectId, group, worktree, reload }: RemoveWorktreeOptions): void {
    const plan = removalPlan(worktree);
    const choice: RemoveChoice = { deleteBranch: plan.branch?.selected ?? false };

    openConfirmModal({
        title: plan.title,
        message: <RemoveMessage worktree={ worktree } plan={ plan } choice={ choice } />,
        confirmLabel: plan.confirmLabel,
        destructive: plan.kind === 'discard',
        onConfirm: async () => {
            const result = await root.command({
                type: 'workspace.remove',
                projectId,
                folderId: group.folderId,
                path: worktree.path,
                ...(plan.kind === 'discard' && { discard: true }),
                ...(plan.branch && choice.deleteBranch && { deleteBranch: true }),
            });

            await reload();

            // The dialog shows a thrown message as an error and stays open.
            if (!result.ok) throw new Error(result.error.message);
        },
    }, { width: 440 });
}
