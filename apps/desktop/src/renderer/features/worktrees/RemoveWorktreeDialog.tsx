import { Box } from '@clowdy/components/Box';
import { Checkbox } from '@clowdy/components/Checkbox';
import { For } from '@clowdy/components/For';
import { openConfirmModal } from '@clowdy/components/modals';
import { Radio, RadioGroup } from '@clowdy/components/Radio';
import { Show } from '@clowdy/components/Show';
import { Text } from '@clowdy/components/Text';
import { toast } from '@clowdy/components/Toast';
import { useId, useState } from 'react';

import { PathText } from '../../shared/PathText';
import { worktreeLabel } from '../agents/workspaceChoice';
import { affectedChats, affectedSummary, readWorktree, refreshWorktreeTarget } from './worktreeActions';
import { branchWarning, removalPlan, removeHint, STRANDED_WARNING } from './worktreeView';

import type { WorktreeInfo } from '@clowdy/protocol';
import type { WorktreeTarget } from './worktreeActions';
import type { RemovalPlan } from './worktreeView';

/** What the person chose in the confirmation besides removing: it is read when the button is pressed. */
interface RemoveChoice {
    deleteBranch: boolean;
    disposition: 'archive' | 'delete';
}

interface RemoveMessageProps {
    worktree: WorktreeInfo;
    plan: RemovalPlan;
    choice: RemoveChoice;
    count: number;
    outside: number;
}

/**
 * The body of the confirmation: which worktree (its branch or commit, and its path), what goes with it, and the branch as a choice of its own. The box starts ticked only for a
 * branch whose work is in the base (and is not the base itself); otherwise the text explains the risk of deleting the branch. A detached HEAD has no branch to
 * offer, and when its commits are not in the base the dialog warns that commits may be lost.
 */
function RemoveMessage({ worktree, plan, choice, count, outside }: RemoveMessageProps) {
    const [deleteBranch, setDeleteBranch] = useState(choice.deleteBranch);
    const [disposition, setDisposition] = useState(choice.disposition);
    const warning = plan.branch && branchWarning(plan.branch);
    const warningId = useId();

    return (
        <Box gap="lg">
            <Box gap="xxs">
                <Text weight="medium" wrap="anywhere">
                    {worktreeLabel(worktree)}
                </Text>
                <PathText path={worktree.path} variant="sm" color="secondary" />
            </Box>

            <Box gap="xs">
                <For each={plan.notes}>
                    {note => (
                        <Text key={note} variant="md" color="secondary">
                            {note}
                        </Text>
                    )}
                </For>
            </Box>

            {count > 0 && (
                <Box gap="xs">
                    <Text weight="medium">{affectedSummary(count, outside)}</Text>
                    <RadioGroup
                        size="sm"
                        aria-label="Chat disposition"
                        value={disposition}
                        onChange={value => {
                            choice.disposition = value === 'delete' ? 'delete' : 'archive';
                            setDisposition(choice.disposition);
                        }}
                    >
                        <Radio value="archive">Archive chats (keep history)</Radio>
                        <Radio value="delete">Delete chats permanently</Radio>
                    </RadioGroup>
                </Box>
            )}

            <Show when={plan.branch}>
                {branch => (
                    <Box gap="xs">
                        <Checkbox
                            size="sm"
                            isSelected={deleteBranch}
                            aria-label={`Also delete the branch ${branch.name}`}
                            aria-describedby={warning ? warningId : undefined}
                            onChange={selected => {
                                choice.deleteBranch = selected;
                                setDeleteBranch(selected);
                            }}
                        >
                            Also delete the branch
                        </Checkbox>
                        <Show when={warning}>
                            {text => (
                                <Text id={warningId} variant="sm" color="warning">
                                    {text}
                                </Text>
                            )}
                        </Show>
                    </Box>
                )}
            </Show>

            <Show when={plan.stranded}>
                <Text variant="md" color="warning">
                    {STRANDED_WARNING}
                </Text>
            </Show>
        </Box>
    );
}

/** Open a confirmation only after reading current Git and chat state. */
export async function openRemoveWorktree(target: WorktreeTarget): Promise<void> {
    const { root, projectId, folderId } = target;
    try {
        const { worktree, snapshot } = await readWorktree(target);
        const chats = affectedChats(worktree, snapshot, folderId);
        const hint = worktree.main ? 'This is the project checkout' : (removeHint(worktree) ?? chats.blocker);
        if (hint) throw new Error(hint);
        const plan = removalPlan(worktree);
        const choice: RemoveChoice = { deleteBranch: plan.branch?.selected ?? false, disposition: 'archive' };
        openConfirmModal(
            {
                title: plan.title,
                message: (
                    <RemoveMessage
                        worktree={worktree}
                        plan={plan}
                        choice={choice}
                        count={chats.ids.size}
                        outside={chats.outside}
                    />
                ),
                confirmLabel: plan.confirmLabel,
                destructive: plan.kind === 'discard' || chats.ids.size > 0,
                initialFocus: plan.kind === 'discard' || chats.ids.size > 0 ? 'cancel' : 'confirm',
                onConfirm: async () => {
                    const { deleteBranch, disposition } = choice;
                    if (chats.ids.size === 0 || deleteBranch || plan.kind === 'discard') {
                        try {
                            const current = await readWorktree(target);
                            if (
                                chats.ids.size === 0 &&
                                affectedChats(current.worktree, current.snapshot, folderId).ids.size > 0
                            ) {
                                throw new Error('The chats linked to this worktree changed. Try again');
                            }
                            // A deletion checkbox authorizes the branch that was shown, not a different
                            // checkout or new commits made while this confirmation was open.
                            if (
                                deleteBranch &&
                                (current.worktree.branch !== worktree.branch ||
                                    current.worktree.head !== worktree.head ||
                                    current.worktree.base !== worktree.base ||
                                    current.worktree.merged !== worktree.merged)
                            )
                                throw new Error('The branch changed. Try again');
                            if (
                                plan.kind === 'discard' &&
                                (current.worktree.changes !== worktree.changes ||
                                    current.worktree.submodules !== worktree.submodules ||
                                    current.worktree.branch !== worktree.branch ||
                                    current.worktree.head !== worktree.head)
                            )
                                throw new Error('The local changes in this worktree changed. Try again');
                        } catch (error) {
                            await refreshWorktreeTarget(target);
                            toast.error({
                                title: "Couldn't remove the worktree",
                                message: error instanceof Error ? error.message : String(error),
                            });
                            return;
                        }
                    }
                    const result = await root.command({
                        type: 'workspace.remove',
                        projectId,
                        folderId,
                        path: worktree.path,
                        ...(plan.kind === 'discard' && { discard: true }),
                        ...(plan.branch && deleteBranch && { deleteBranch: true }),
                        ...(chats.ids.size > 0 && {
                            chatDisposition: disposition,
                            expectedChatIds: [...chats.ids],
                        }),
                    });
                    await refreshWorktreeTarget(target, chats.affected);
                    if (!result.ok)
                        toast.error({ title: "Couldn't remove the worktree", message: result.error.message });
                },
            },
            { width: 440 }
        );
    } catch (error) {
        await refreshWorktreeTarget(target);
        toast.error({
            title: "Couldn't remove the worktree",
            message: error instanceof Error ? error.message : String(error),
        });
    }
}
