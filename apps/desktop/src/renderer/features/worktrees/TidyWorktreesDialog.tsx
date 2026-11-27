import { Box } from '@clowdy/components/Box';
import { Button } from '@clowdy/components/Button';
import { Checkbox } from '@clowdy/components/Checkbox';
import { openConfirmModal } from '@clowdy/components/modals';
import { Text } from '@clowdy/components/Text';
import { toast } from '@clowdy/components/Toast';
import { errorMessage } from '@clowdy/lib';
import { useEffect, useState } from 'react';

import { useRootStore } from '../../stores';
import { worktreeLabel } from '../agents/workspaceChoice';
import { refreshFolderGit } from '../openWith';
import styles from './ManageWorktrees.module.css';
import { WorktreeRowSummary } from './WorktreeRow';
import {
    affectedChats,
    archiveConsequence,
    chatPreviewChanged,
    linkedChatIds,
    readRemoval,
    removeWorktree,
} from './worktreeActions';
import { deleteBranchByDefault, removalPlan, repositoryGroups, STRANDED_WARNING } from './worktreeView';

import type { FolderId, FolderWorktrees, ProjectId, ProjectSnapshot, WorktreeInfo } from '@clowdy/protocol';

type Group = { group: FolderWorktrees; folder: { id: FolderId } };
const keyOf = (folderId: FolderId, path: string) => JSON.stringify([folderId, path]);

function eligible(row: WorktreeInfo, folderId: FolderId, snapshot: ProjectSnapshot) {
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

/** Cleanup is a mode of the project worktree list; the daemon checks every removal again. */
export function TidyWorktreesMode({
    projectId,
    onCancel,
    reload,
}: {
    projectId: ProjectId;
    onCancel: () => void;
    reload: () => Promise<void>;
}) {
    const root = useRootStore();
    const project = root.projects.find(candidate => candidate.id === projectId);
    const [data, setData] = useState<{ groups: Group[]; snapshot: ProjectSnapshot }>();
    const [failed, setFailed] = useState(false);
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
    const [deleteBranches, setDeleteBranches] = useState(true);
    useEffect(() => {
        let live = true;
        const currentProject = root.projects.find(candidate => candidate.id === projectId);
        if (!currentProject) return;
        Promise.all([root.transport.getProjectWorktrees(projectId), root.transport.getProjectSnapshot(projectId)]).then(
            ([folders, snapshot]) => {
                if (!live) return;
                const groups = repositoryGroups(folders, currentProject.folders);
                setData({ groups, snapshot });
                setSelected(
                    new Set(
                        groups.flatMap(({ group }) =>
                            group.worktrees
                                .filter(row => eligible(row, group.folderId, snapshot))
                                .map(row => keyOf(group.folderId, row.path))
                        )
                    )
                );
            },
            () => {
                if (live) setFailed(true);
            }
        );
        return () => {
            live = false;
        };
    }, [root, projectId]);

    const remove = () => {
        if (!data || !project) return;
        const choices = data.groups.flatMap(({ group }) =>
            group.worktrees
                .filter(row => selected.has(keyOf(group.folderId, row.path)))
                .map(row => ({ folderId: group.folderId, row, safe: eligible(row, group.folderId, data.snapshot) }))
        );
        let previews: {
            folderId: FolderId;
            row: WorktreeInfo;
            safe: boolean;
            chats: ReturnType<typeof affectedChats>;
        }[];
        try {
            previews = choices.map(choice => ({
                ...choice,
                chats: affectedChats(choice.row, data.snapshot, choice.folderId),
            }));
        } catch (error) {
            toast.error({ message: errorMessage(error, "Couldn't read linked chats") });
            return;
        }
        let report: { removed: number; errors: string[] } | undefined;
        openConfirmModal(
            {
                title: 'Remove selected worktrees?',
                message: (
                    <Box gap="md">
                        <Text>
                            Selected worktrees will be removed. Review linked chats and threads, including those in
                            other worktrees.
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
                                    ? [
                                          `${chats.outside} ${chats.outside === 1 ? 'thread' : 'threads'} in other worktrees`,
                                      ]
                                    : []),
                                ...(deleteBranches && deleteBranchByDefault(row)
                                    ? [`Merged branch ${row.branch} will be deleted`]
                                    : []),
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
                    </Box>
                ),
                confirmLabel: `Remove ${selected.size} ${selected.size === 1 ? 'worktree' : 'worktrees'}`,
                destructive: true,
                initialFocus: 'cancel',
                onConfirm: async () => {
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
                    onCancel();
                    if (errors.length) report = { removed, errors };
                    else if (removed)
                        toast.success({ message: `Removed ${removed} ${removed === 1 ? 'worktree' : 'worktrees'}` });
                },
            },
            {
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
            }
        );
    };

    return (
        <div className={styles.groups}>
            <Text color="secondary" variant="sm">
                Clean, merged worktrees without unarchived chats are selected for you. Review other worktrees before
                selecting them
            </Text>
            {failed && (
                <Text color="warning" role="alert">
                    Couldn't read worktrees
                </Text>
            )}
            {!data && !failed && <Text color="secondary">Loading worktrees…</Text>}
            <div className={styles.tidyRows}>
                {data?.groups.map(({ group }) => (
                    <section className={styles.group} key={group.folderId} data-folder-id={group.folderId}>
                        <Text as="h3" variant="heading-5">
                            {group.name}
                        </Text>
                        {!group.isRepository ? (
                            <Text variant="sm" color="secondary">
                                This folder is not a git repository
                            </Text>
                        ) : (
                            <ul className={styles.card}>
                                {group.worktrees.map(row => {
                                    const key = keyOf(group.folderId, row.path);
                                    const canRemove =
                                        !row.main &&
                                        row.blocked !== 'main' &&
                                        row.blocked !== 'locked' &&
                                        row.locked === undefined;
                                    return (
                                        <li key={key} data-worktree-path={row.path}>
                                            <Checkbox
                                                className={`${styles.row} ${styles.tidyCheck}`}
                                                size="sm"
                                                isDisabled={!canRemove}
                                                isSelected={selected.has(key)}
                                                aria-label={`Remove ${worktreeLabel(row)}: ${row.path}`}
                                                onChange={checked =>
                                                    setSelected(current => {
                                                        const next = new Set(current);
                                                        if (checked) next.add(key);
                                                        else next.delete(key);
                                                        return next;
                                                    })
                                                }
                                            >
                                                <span className={styles.tidySummary}>
                                                    <WorktreeRowSummary worktree={row} tidy />
                                                </span>
                                            </Checkbox>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </section>
                ))}
            </div>
            {data && !selected.size && (
                <Text color="secondary" variant="sm">
                    No worktrees selected
                </Text>
            )}
            {data && (
                <Checkbox size="sm" isSelected={deleteBranches} onChange={setDeleteBranches}>
                    Also delete merged branches
                </Checkbox>
            )}
            <Box direction="row" gap="sm">
                <Button variant="bordered" onPress={onCancel}>
                    Cancel
                </Button>
                <Button color="danger" isDisabled={!selected.size} onPress={remove}>
                    Remove {selected.size} {selected.size === 1 ? 'worktree' : 'worktrees'}…
                </Button>
            </Box>
        </div>
    );
}
