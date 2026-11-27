import { Box } from '@clowdy/components/Box';
import { Checkbox } from '@clowdy/components/Checkbox';
import { ConfirmModalContent, openConfirmModal, openFormDialog } from '@clowdy/components/modals';
import { Text } from '@clowdy/components/Text';
import { toast } from '@clowdy/components/Toast';
import { errorMessage } from '@clowdy/lib';
import { useState } from 'react';

import { worktreeLabel } from '../agents/workspaceChoice';
import styles from './ManageWorktrees.module.css';
import { WorktreeRowSummary } from './WorktreeRow';
import { linkedChatIds, refreshWorktreeTarget } from './worktreeActions';
import { removalPlan } from './worktreeView';

import type { WorktreeInfo } from '@clowdy/protocol';
import type { WorktreeTarget } from './worktreeActions';

type TidyTarget = Omit<WorktreeTarget, 'path'>;

/** The worktrees ticked for removal, by path, and whether their merged branches go too. */
interface TidyChoice {
    selected: ReadonlySet<string>;
    deleteBranches: boolean;
}

function TidyPreview({ rows, onConfirm }: { rows: WorktreeInfo[]; onConfirm: (choice: TidyChoice) => Promise<void> }) {
    const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(rows.map(row => row.path)));
    const [deleteBranches, setDeleteBranches] = useState(true);
    const [removing, setRemoving] = useState(false);

    return (
        <ConfirmModalContent
            title="Tidy up worktrees?"
            message={
                <Box gap="xl">
                    <Text color="secondary" variant="md">
                        Select merged worktrees with no local changes, submodules or unarchived chats. Archived chat
                        history stays.
                    </Text>
                    <div className={styles.tidyRows}>
                        <ul className={styles.card} aria-label="Worktrees to remove">
                            {rows.map(row => (
                                <li key={row.path}>
                                    <Checkbox
                                        className={`${styles.row} ${styles.tidyCheck}`}
                                        size="sm"
                                        isDisabled={removing}
                                        isSelected={selected.has(row.path)}
                                        aria-label={`Remove ${worktreeLabel(row)}: ${row.path}`}
                                        onChange={checked => {
                                            const next = new Set(selected);
                                            if (checked) next.add(row.path);
                                            else next.delete(row.path);
                                            setSelected(next);
                                        }}
                                    >
                                        <span className={styles.tidySummary}>
                                            <WorktreeRowSummary worktree={row} tidy />
                                        </span>
                                    </Checkbox>
                                </li>
                            ))}
                        </ul>
                    </div>
                    <Checkbox size="sm" isDisabled={removing} isSelected={deleteBranches} onChange={setDeleteBranches}>
                        Also delete merged branches
                    </Checkbox>
                </Box>
            }
            confirmLabel={`Remove ${selected.size} ${selected.size === 1 ? 'workspace' : 'workspaces'}`}
            destructive
            initialFocus="cancel"
            isConfirmDisabled={selected.size === 0}
            onConfirm={async () => {
                setRemoving(true);
                try {
                    await onConfirm({ selected, deleteBranches });
                } catch (error) {
                    setRemoving(false);
                    throw error;
                }
            }}
        />
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
        let report: { removed: number; errors: string[] } | undefined;
        openFormDialog({
            layer: 'confirm',
            role: 'alertdialog',
            closeButton: false,
            width: 540,
            component: (
                <TidyPreview
                    rows={rows}
                    onConfirm={async ({ selected, deleteBranches }) => {
                        let removed = 0;
                        const errors: string[] = [];
                        for (const row of rows.filter(row => selected.has(row.path))) {
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
                            toast.success({
                                message: `Removed ${removed} ${removed === 1 ? 'worktree' : 'worktrees'}`,
                            });
                    }}
                />
            ),
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
        });
    } catch (error) {
        await refreshWorktreeTarget(target);
        toast.error({
            title: "Couldn't read worktrees",
            message: errorMessage(error, 'Something went wrong'),
        });
    }
}
