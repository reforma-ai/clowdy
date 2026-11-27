import { Box } from '@clowdy/components/Box';
import { Checkbox } from '@clowdy/components/Checkbox';
import { ConfirmModalContent, openConfirmModal, openFormDialog } from '@clowdy/components/modals';
import { Text } from '@clowdy/components/Text';
import { toast } from '@clowdy/components/Toast';
import { errorMessage } from '@clowdy/lib';
import { useState } from 'react';

import { worktreeLabel } from '../agents/workspaceChoice';
import { refreshFolderGit } from '../openWith';
import {
    affectedChats,
    archiveConsequence,
    chatPreviewChanged,
    linkedChatIds,
    readRemoval,
    removeWorktree,
} from './worktreeActions';
import { deleteBranchByDefault, removalPlan, STRANDED_WARNING } from './worktreeView';

import type { FolderId, Project, ProjectId, ProjectSnapshot, WorktreeInfo } from '@clowdy/protocol';
import type { RootStore } from '../../stores';

export const keyOf = (folderId: FolderId, path: string) => JSON.stringify([folderId, path]);

export function eligible(row: WorktreeInfo, folderId: FolderId, snapshot: ProjectSnapshot) {
    if (
        row.main ||
        row.missing ||
        row.blocked ||
        row.locked !== undefined ||
        row.changes !== 0 ||
        row.submodules ||
        row.merged !== true ||
        row.base === undefined
    )
        return false;
    const linked = linkedChatIds(row, snapshot, folderId);
    return !snapshot.chats.some(chat => linked.has(chat.id) && chat.archivedAt === undefined);
}

export function canRemove(row: WorktreeInfo): boolean {
    return !row.main && row.blocked !== 'main' && row.blocked !== 'locked' && row.locked === undefined;
}

type TidyPreview = {
    folderId: FolderId;
    row: WorktreeInfo;
    safe: boolean;
    chats: ReturnType<typeof affectedChats>;
};

/** Lock the branch choice as soon as the confirmed operation starts. */
function TidyConfirmation({
    previews,
    onConfirm,
}: {
    previews: TidyPreview[];
    onConfirm: (deleteBranches: boolean) => Promise<void>;
}) {
    const [deleteBranches, setDeleteBranches] = useState(true);
    const [pending, setPending] = useState(false);
    return (
        <ConfirmModalContent
            title="Remove selected worktrees?"
            message={
                <Box gap="md">
                    <Text>
                        Selected worktrees will be removed. Review linked chats and threads, including those in other
                        worktrees.
                    </Text>
                    {previews.map(({ folderId, row, chats, safe }) => {
                        const plan = removalPlan(row);
                        const details = [
                            ...plan.notes,
                            ...(plan.stranded ? [STRANDED_WARNING] : []),
                            ...(chats.ids.size
                                ? [
                                      safe
                                          ? 'Linked chats and threads stay as they are'
                                          : archiveConsequence(chats.affected),
                                  ]
                                : []),
                            ...(chats.outside
                                ? [`${chats.outside} ${chats.outside === 1 ? 'thread' : 'threads'} in other worktrees`]
                                : []),
                            ...(deleteBranchByDefault(row) ? [`Merged branch ${row.branch} can also be deleted`] : []),
                            ...(chats.blocker ? [chats.blocker] : []),
                        ];
                        return (
                            <Box key={keyOf(folderId, row.path)} gap="xs">
                                <Text weight="medium" wrap="anywhere">
                                    {worktreeLabel(row)} — {row.path}
                                </Text>
                                {chats.affected.map(chat => (
                                    <Text key={chat.id} color="secondary" variant="sm" wrap="anywhere">
                                        {chat.title} —{' '}
                                        {chat.archivedAt === undefined ? 'Not archived' : 'Already archived'}
                                    </Text>
                                ))}
                                {details.map(detail => (
                                    <Text key={detail} color="secondary" variant="sm">
                                        {detail}
                                    </Text>
                                ))}
                            </Box>
                        );
                    })}
                    <Checkbox size="sm" isDisabled={pending} isSelected={deleteBranches} onChange={setDeleteBranches}>
                        Also delete merged branches
                    </Checkbox>
                </Box>
            }
            confirmLabel={`Remove ${previews.length} ${previews.length === 1 ? 'worktree' : 'worktrees'}`}
            destructive
            initialFocus="cancel"
            onConfirm={async () => {
                setPending(true);
                try {
                    await onConfirm(deleteBranches);
                } catch (error) {
                    setPending(false);
                    throw error;
                }
            }}
        />
    );
}

/** Confirm and remove the exact rows selected in the shared list. */
export function confirmTidyWorktrees({
    root,
    project,
    projectId,
    choices,
    snapshot,
    reload,
    onComplete,
}: {
    root: RootStore;
    project: Project;
    projectId: ProjectId;
    choices: { folderId: FolderId; row: WorktreeInfo; safe: boolean }[];
    snapshot: ProjectSnapshot;
    reload: () => Promise<void>;
    onComplete: () => void;
}) {
    let previews: TidyPreview[];
    try {
        previews = choices.map(choice => ({
            ...choice,
            chats: affectedChats(choice.row, snapshot, choice.folderId),
        }));
    } catch (error) {
        toast.error({ message: errorMessage(error, "Couldn't read linked chats") });
        return;
    }
    let report: { removed: number; errors: string[] } | undefined;
    openFormDialog({
        layer: 'confirm',
        role: 'alertdialog',
        closeButton: false,
        width: 380,
        component: (
            <TidyConfirmation
                previews={previews}
                onConfirm={async deleteBranches => {
                    let removed = 0;
                    const errors: string[] = [];
                    // An earlier selected worktree may archive a chat also linked to a later one.
                    const archivedByThisAction = new Set<string>();
                    for (const { folderId, row, safe, chats } of previews) {
                        try {
                            const target = { root, projectId, folderId, path: row.path };
                            const read = await readRemoval(target, { worktree: row, chats });
                            const expectedChats = chats.affected.map(chat =>
                                archivedByThisAction.has(chat.id) && chat.archivedAt === undefined
                                    ? { ...chat, archivedAt: 1 }
                                    : chat
                            );
                            if (
                                read.drift.branch ||
                                read.drift.chats ||
                                chatPreviewChanged(expectedChats, read.chats.affected)
                            )
                                throw new Error('The worktree or linked chats changed. Try again');
                            if (safe) {
                                const result = await root.command({
                                    type: 'workspace.remove',
                                    projectId,
                                    folderId,
                                    path: row.path,
                                    tidy: true,
                                    ...(deleteBranches && removalPlan(row).branch?.selected && { deleteBranch: true }),
                                });
                                if (!result.ok) throw new Error(result.error.message);
                            } else {
                                await removeWorktree(target, read, {
                                    deleteBranch: deleteBranches && deleteBranchByDefault(row),
                                    disposition: 'archive',
                                });
                            }
                            if (!safe) for (const chat of read.chats.affected) archivedByThisAction.add(chat.id);
                            removed++;
                        } catch (error) {
                            errors.push(
                                `${worktreeLabel(row)} (${row.path}): ${errorMessage(error, 'Something went wrong')}`
                            );
                        }
                    }
                    for (const folder of project.folders) refreshFolderGit(projectId, folder.id);
                    await reload();
                    onComplete();
                    if (errors.length) report = { removed, errors };
                    else if (removed)
                        toast.success({ message: `Removed ${removed} ${removed === 1 ? 'worktree' : 'worktrees'}` });
                }}
            />
        ),
        onClose: () => {
            if (!report) return;
            const result = report;
            queueMicrotask(() =>
                openConfirmModal({
                    title: 'Tidy up results',
                    message: (
                        <Box gap="sm">
                            <Text>
                                {result.removed} removed, {result.errors.length} refused or incomplete
                            </Text>
                            {result.errors.map(error => (
                                <Text key={error} color="warning" variant="sm" wrap="anywhere">
                                    {error}
                                </Text>
                            ))}
                        </Box>
                    ),
                    confirmLabel: 'OK',
                    showCancel: false,
                    onConfirm: () => {},
                })
            );
        },
    });
}
