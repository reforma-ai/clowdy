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
import { deleteBranchByDefault, removalPlan, removeHint } from './worktreeView';

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
    return !row.main && row.locked === undefined && removeHint(row) === undefined;
}

type TidyPreview = {
    folderId: FolderId;
    row: WorktreeInfo;
    safe: boolean;
    chats: ReturnType<typeof affectedChats>;
};

/** The base branch must outlive its dependents' merge checks. Groups can share a Git repository,
 * so matching names across folder groups conservatively count as a dependency too. Unrelated ready rows
 * stay in input order. Names in different repositories may form an apparent cycle, so prefer dependencies in the same folder
 * if the cross-folder ordering stalls. If even that forms a cycle, keep the remaining input order and let the daemon check each row. */
function removalOrder(previews: readonly TidyPreview[], deleteBranches: boolean): readonly TidyPreview[] {
    if (!deleteBranches) return previews;
    const remaining = [...previews];
    const ordered: TidyPreview[] = [];
    const baseUses = new Map<string, number>();
    const localUses = new Map<string, number>();
    const countBase = ({ row, folderId }: TidyPreview, delta: number) => {
        if (!row.base) return;
        const localKey = keyOf(folderId, row.base);
        baseUses.set(row.base, (baseUses.get(row.base) ?? 0) + delta);
        localUses.set(localKey, (localUses.get(localKey) ?? 0) + delta);
    };
    for (const preview of previews) {
        countBase(preview, 1);
    }
    while (remaining.length) {
        let index = remaining.findIndex(
            ({ row }) => !row.branch || !deleteBranchByDefault(row) || !baseUses.get(row.branch)
        );
        if (index === -1) {
            index = remaining.findIndex(
                ({ row, folderId }) => !row.branch || !localUses.get(keyOf(folderId, row.branch))
            );
        }
        if (index === -1) return [...ordered, ...remaining];
        const [next] = remaining.splice(index, 1);
        countBase(next, -1);
        ordered.push(next);
    }
    return ordered;
}

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
            const errors: string[] = [];
            // An earlier selected worktree may archive a chat also linked to a later one.
            const archivedByThisAction = new Set<string>();
            for (const { folderId, row, safe, chats } of removalOrder(previews, deleteBranches)) {
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
                        if (!result.ok) throw new Error(result.error.message);
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
            return { removed, errors };
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
                    .then(({ removed, errors }) => {
                        if (errors.length) {
                            toast.warning({
                                title: 'Worktree cleanup finished',
                                message: `${removed} removed, ${errors.length} refused or incomplete`,
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
