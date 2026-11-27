import { Box } from '@clowdy/components/Box';
import { Button } from '@clowdy/components/Button';
import { Checkbox } from '@clowdy/components/Checkbox';
import { openConfirmModal } from '@clowdy/components/modals';
import { Text } from '@clowdy/components/Text';
import { toast } from '@clowdy/components/Toast';
import { useEffect, useState } from 'react';

import { useRootStore } from '../../stores';
import { worktreeLabel } from '../agents/workspaceChoice';
import { refreshFolderGit } from '../openWith';
import styles from './ManageWorktrees.module.css';
import { WorktreeRowSummary } from './WorktreeRow';
import { linkedChatIds } from './worktreeActions';
import { removalPlan, repositoryGroups } from './worktreeView';

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
        let report: { removed: number; errors: string[] } | undefined;
        openConfirmModal(
            {
                title: 'Remove selected worktrees?',
                message: `Remove ${selected.size} ${selected.size === 1 ? 'worktree' : 'worktrees'}${deleteBranches ? ' and their eligible merged branches' : ''}? Archived chat history stays.`,
                confirmLabel: `Remove ${selected.size} ${selected.size === 1 ? 'worktree' : 'worktrees'}`,
                destructive: true,
                initialFocus: 'cancel',
                onConfirm: async () => {
                    let removed = 0;
                    const errors: string[] = [];
                    for (const { group } of data.groups)
                        for (const row of group.worktrees) {
                            if (!selected.has(keyOf(group.folderId, row.path))) continue;
                            const result = await root.command({
                                type: 'workspace.remove',
                                projectId,
                                folderId: group.folderId,
                                path: row.path,
                                tidy: true,
                                ...(deleteBranches && removalPlan(row).branch?.selected && { deleteBranch: true }),
                            });
                            if (result.ok) removed++;
                            else errors.push(`${worktreeLabel(row)} (${row.path}): ${result.error.message}`);
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
                Select merged worktrees with no local changes, submodules or unarchived chats
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
                                    const canRemove = eligible(row, group.folderId, data.snapshot);
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
