import { Box } from '@clowdy/components/Box';
import { Checkbox } from '@clowdy/components/Checkbox';
import { openConfirmModal } from '@clowdy/components/modals';
import { Text } from '@clowdy/components/Text';
import { toast } from '@clowdy/components/Toast';
import { useState } from 'react';

import { worktreeLabel } from '../agents/workspaceChoice';
import styles from './ManageWorktrees.module.css';
import { WorktreeRowSummary } from './WorktreeRow';
import { linkedChatIds, refreshWorktreeTarget } from './worktreeActions';
import { removalPlan } from './worktreeView';

import type { WorktreeInfo } from '@clowdy/protocol';
import type { WorktreeTarget } from './worktreeActions';

type TidyTarget = Omit<WorktreeTarget, 'path'>;

interface Choice {
    selected: Set<string>;
    deleteBranches: boolean;
}

function TidyPreview({ rows, choice }: { rows: WorktreeInfo[]; choice: Choice }) {
    const [selected, setSelected] = useState(choice.selected);
    const [deleteBranches, setDeleteBranches] = useState(choice.deleteBranches);
    return (
        <Box gap="md">
            <Text color="secondary" variant="md">
                Select merged worktrees with no local changes, submodules or unarchived chats. Archived chat history
                stays.
            </Text>
            <div className={styles.tidyRows}>
                <ul className={styles.card} aria-label="Worktrees to remove">
                    {rows.map(row => (
                        <li key={row.path} className={styles.row}>
                            <WorktreeRowSummary worktree={row} />
                            <Checkbox
                                className={styles.tidyCheck}
                                size="sm"
                                isSelected={selected.has(row.path)}
                                aria-label={`Remove ${worktreeLabel(row)}: ${row.path}`}
                                onChange={checked => {
                                    const next = new Set(selected);
                                    if (checked) next.add(row.path);
                                    else next.delete(row.path);
                                    choice.selected = next;
                                    setSelected(next);
                                }}
                            />
                        </li>
                    ))}
                </ul>
            </div>
            <Text variant="sm" color="secondary">
                {selected.size} of {rows.length} selected
            </Text>
            <Checkbox
                size="sm"
                isSelected={deleteBranches}
                onChange={checked => {
                    choice.deleteBranches = checked;
                    setDeleteBranches(checked);
                }}
            >
                Also delete merged branches (except the base branch)
            </Checkbox>
        </Box>
    );
}

export async function openTidyWorktrees(target: TidyTarget): Promise<void> {
    const { root, projectId, folderId } = target;
    try {
        const folders = await root.transport.getProjectWorktrees(projectId);
        const snapshot = await root.transport.getProjectSnapshot(projectId);
        const rows = (folders.find(group => group.folderId === folderId)?.worktrees ?? []).filter(row => {
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
        });
        if (!rows.length) {
            openConfirmModal({
                title: 'Nothing to tidy up',
                message: 'No clean, merged and unused worktrees in this folder',
                confirmLabel: 'OK',
                showCancel: false,
                onConfirm: () => {},
            });
            return;
        }
        const choice: Choice = { selected: new Set(rows.map(row => row.path)), deleteBranches: true };
        let report: { removed: number; errors: string[] } | undefined;
        openConfirmModal(
            {
                title: 'Tidy up worktrees?',
                message: <TidyPreview rows={rows} choice={choice} />,
                confirmLabel: 'Remove selected',
                initialFocus: 'cancel',
                destructive: true,
                onConfirm: async () => {
                    const deleteBranches = choice.deleteBranches;
                    let removed = 0;
                    const errors: string[] = [];
                    for (const row of rows.filter(row => choice.selected.has(row.path))) {
                        const result = await root.command({
                            type: 'workspace.remove',
                            projectId,
                            folderId,
                            path: row.path,
                            tidy: true,
                            ...(deleteBranches && removalPlan(row).branch?.selected && { deleteBranch: true }),
                        });
                        if (result.ok) removed++;
                        else errors.push(`${worktreeLabel(row)} (${row.path}): ${result.error.message}`);
                    }
                    await refreshWorktreeTarget(target);
                    if (errors.length) {
                        report = { removed, errors };
                    } else if (removed)
                        toast.success({ message: `Removed ${removed} ${removed === 1 ? 'worktree' : 'worktrees'}` });
                },
            },
            {
                width: 540,
                onClose: () => {
                    const result = report;
                    if (!result) return;
                    // The preview must be closed before opening the result window.
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
    } catch (error) {
        await refreshWorktreeTarget(target);
        toast.error({
            title: "Couldn't read worktrees",
            message: error instanceof Error ? error.message : String(error),
        });
    }
}
