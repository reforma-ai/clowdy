import { Box } from '@clowdy/components/Box';
import { Checkbox } from '@clowdy/components/Checkbox';
import { ConfirmModalContent, openConfirmModal, openFormDialog } from '@clowdy/components/modals';
import { Text } from '@clowdy/components/Text';
import { toast } from '@clowdy/components/Toast';
import { errorMessage } from '@clowdy/lib';
import { useState } from 'react';

import { worktreeLabel } from '../agents/workspaceChoice';
import { refreshFolderGit } from '../openWith';
import { affectedChats, chatPreviewChanged, readRemoval, removeWorktree } from './worktreeActions';
import { deleteBranchByDefault, removalPlan } from './worktreeView';

import type { FolderId, Project, ProjectId, ProjectSnapshot, WorktreeInfo } from '@clowdy/protocol';
import type { RootStore } from '../../stores';

export const keyOf = (folderId: FolderId, path: string) => JSON.stringify([folderId, path]);

export function eligible(row: WorktreeInfo, folderId: FolderId, snapshot: ProjectSnapshot) {
    if (
        row.main ||
        row.active ||
        row.missing ||
        (row.blocked && row.blocked !== 'chats') ||
        row.locked !== undefined ||
        row.changes !== 0 ||
        row.submodules ||
        row.merged !== true ||
        row.base === undefined
    )
        return false;
    try {
        return !affectedChats(row, snapshot, folderId).blocker;
    } catch {
        // A partial snapshot is not enough to judge whether every linked chat is stopped.
        return false;
    }
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

/** Confirm the branch choice before handing off to the background operation. */
function TidyConfirmation({
    previews,
    onConfirm,
}: {
    previews: TidyPreview[];
    onConfirm: (deleteBranches: boolean) => void;
}) {
    const [deleteBranches, setDeleteBranches] = useState(true);
    const label = `Remove ${previews.length} ${previews.length === 1 ? 'worktree' : 'worktrees'}`;
    const warnings = [
        previews.some(({ row }) => !row.missing && (row.changes > 0 || row.submodules)) &&
            'Uncommitted changes will be lost',
        previews.some(({ row }) => removalPlan(row).stranded) && 'Detached commits may be lost',
        previews.some(({ chats }) => chats.affected.some(chat => chat.archivedAt === undefined)) &&
            'Linked chats and their threads will be archived',
        previews.some(({ row, chats }) => row.active || chats.blocker) &&
            'Worktrees with running chats will be skipped',
    ].filter(Boolean);
    return (
        <ConfirmModalContent
            title={`${label}?`}
            message={
                <Box gap="md">
                    {warnings.length > 0 && (
                        <Text color="secondary">
                            {warnings.join('. ')}
                            {warnings.length > 1 ? '.' : ''}
                        </Text>
                    )}
                    <Checkbox size="sm" isSelected={deleteBranches} onChange={setDeleteBranches}>
                        Also delete merged branches
                    </Checkbox>
                </Box>
            }
            confirmLabel={label}
            destructive
            initialFocus="cancel"
            onConfirm={() => onConfirm(deleteBranches)}
        />
    );
}

const active = new WeakMap<RootStore, Set<ProjectId>>();
const finished = new Set<(root: RootStore, projectId: ProjectId) => void>();

export function onTidyFinished(listener: (root: RootStore, projectId: ProjectId) => void): () => void {
    finished.add(listener);
    return () => void finished.delete(listener);
}

/** Confirm and remove the exact rows selected in the shared list. */
export function confirmTidyWorktrees({
    root,
    project,
    projectId,
    choices,
    snapshot,
    onStart,
}: {
    root: RootStore;
    project: Project;
    projectId: ProjectId;
    choices: { folderId: FolderId; row: WorktreeInfo; safe: boolean }[];
    snapshot: ProjectSnapshot;
    onStart: () => void;
}) {
    let projects = active.get(root);
    if (!projects) {
        projects = new Set();
        active.set(root, projects);
    }
    const running = projects;
    if (running.has(projectId)) {
        toast.info({ message: 'Worktree cleanup is already running' });
        return;
    }
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
    let accepted: boolean | undefined;
    const run = async (deleteBranches: boolean) => {
        const progress = toast.progress({ title: 'Removing worktrees', total: previews.length });
        try {
            let removed = 0;
            let branchesKept = 0;
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
                    if (read.drift.branch || read.drift.chats || chatPreviewChanged(expectedChats, read.chats.affected))
                        throw new Error('The worktree or linked chats changed. Try again');
                    if (safe) {
                        const result = await root.command({
                            type: 'workspace.remove',
                            projectId,
                            folderId,
                            path: row.path,
                            tidy: true,
                            ...(read.chats.affected.some(chat => chat.archivedAt === undefined) && {
                                chatDisposition: 'archive',
                                expectedChatIds: [...read.chats.ids],
                            }),
                            ...(deleteBranches && removalPlan(row).branch?.selected && { deleteBranch: true }),
                        });
                        if (!result.ok) {
                            // Dev/OTA can leave an older daemon running while its agents finish. This exact invalid
                            // response is sent before any Git mutation; no other failure is safe to retry.
                            if (
                                result.error.code !== 'invalid' ||
                                result.error.message !== 'Tidy up cannot discard changes or dispose of chats' ||
                                !read.chats.affected.some(chat => chat.archivedAt === undefined)
                            ) {
                                throw new Error(result.error.message);
                            }
                            await removeWorktree(
                                target,
                                read,
                                {
                                    deleteBranch: false,
                                    disposition: 'archive',
                                },
                                { legacyTidy: true }
                            );
                            if (deleteBranches && deleteBranchByDefault(row)) branchesKept++;
                        }
                    } else {
                        await removeWorktree(target, read, {
                            deleteBranch: deleteBranches && deleteBranchByDefault(row),
                            disposition: 'archive',
                        });
                    }
                    for (const chat of read.chats.affected) archivedByThisAction.add(chat.id);
                    removed++;
                } catch (error) {
                    errors.push(`${worktreeLabel(row)} (${row.path}): ${errorMessage(error, 'Something went wrong')}`);
                } finally {
                    progress.update(removed + errors.length);
                }
            }
            for (const folder of project.folders) refreshFolderGit(projectId, folder.id);
            return { removed, branchesKept, errors };
        } finally {
            progress.close();
        }
    };
    openFormDialog({
        layer: 'confirm',
        role: 'alertdialog',
        closeButton: false,
        width: 380,
        component: (
            <TidyConfirmation
                previews={previews}
                onConfirm={deleteBranches => {
                    if (running.has(projectId)) {
                        toast.info({ message: 'Worktree cleanup is already running' });
                        return;
                    }
                    running.add(projectId);
                    accepted = deleteBranches;
                }}
            />
        ),
        onClose: () => {
            if (accepted === undefined) return;
            const deleteBranches = accepted;
            // The child must close first, so it cannot restore focus into a closed parent.
            queueMicrotask(() => {
                onStart();
                void run(deleteBranches)
                    .then(({ removed, branchesKept, errors }) => {
                        if (errors.length) {
                            toast.warning({
                                title: 'Worktree cleanup finished',
                                message: `${removed} removed, ${errors.length} refused or incomplete${branchesKept ? `, ${branchesKept} ${branchesKept === 1 ? 'branch' : 'branches'} kept because the daemon is out of date` : ''}`,
                                timeout: 0,
                                action: {
                                    label: 'View details',
                                    onPress: () =>
                                        openConfirmModal({
                                            title: 'Tidy up results',
                                            message: (
                                                <Box gap="sm">
                                                    {errors.map(error => (
                                                        <Text key={error} color="warning" variant="sm" wrap="anywhere">
                                                            {error}
                                                        </Text>
                                                    ))}
                                                </Box>
                                            ),
                                            confirmLabel: 'OK',
                                            showCancel: false,
                                            onConfirm: () => {},
                                        }),
                                },
                            });
                        } else if (branchesKept) {
                            toast.warning({
                                title: 'Worktree cleanup finished',
                                message: `${removed} removed, ${branchesKept} ${branchesKept === 1 ? 'branch' : 'branches'} kept because the daemon is out of date`,
                                timeout: 0,
                            });
                        } else if (removed) {
                            toast.success({
                                message: `Removed ${removed} ${removed === 1 ? 'worktree' : 'worktrees'}`,
                            });
                        }
                    })
                    .catch(error => {
                        toast.error({ message: errorMessage(error, "Couldn't finish worktree cleanup"), timeout: 0 });
                    })
                    .finally(() => {
                        running.delete(projectId);
                        for (const listener of finished) listener(root, projectId);
                    });
            });
        },
    });
}
