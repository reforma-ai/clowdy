import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { Check, ChevronRight, Close } from '@clowdy/icons/14';

import { useProjectUi } from '../../stores';
import { quoteIntoComposer } from '../chats/composerBridge';
import { confirmAbortMerge } from './confirmAbortMerge';
import { splitPath } from './gitSummary';
import styles from './MergeFiles.module.css';
import { useRemoteActions } from './useRemoteActions';

import type { GitStatus, GitStatusEntry } from '@clowdy/protocol';
import type { ReactNode } from 'react';
import type { PlaceChanges } from './PlaceChanges';

function FileGroup({
    label,
    count,
    conflict,
    children,
}: {
    label: string;
    count: number;
    conflict?: boolean;
    children: ReactNode;
}) {
    return (
        <details open className={styles.group} data-conflict={conflict || undefined}>
            <summary className={styles.heading}>
                <ChevronRight size={12} aria-hidden="true" className={styles.chevron} />
                <Text variant="sm" weight="medium">
                    {label}
                </Text>
                <Text variant="xs" color="secondary" className={styles.count}>
                    {count}
                </Text>
            </summary>
            <div className={styles.body}>{children}</div>
        </details>
    );
}

function MergeFileList({
    model,
    entries,
    conflicts,
}: {
    model: PlaceChanges;
    entries: readonly GitStatusEntry[];
    conflicts?: boolean;
}) {
    if (entries.length === 0) return null;

    const diffs = new Map(model.uncommitted?.files.map(file => [file.path, file]));

    return (
        <ul aria-label={conflicts ? 'Conflicting files' : 'Staged files'} className={styles.list}>
            {entries.map(entry => {
                const { path, unstaged } = entry;
                const { name } = splitPath(path);
                // The diff includes worktree edits, so only show its counts for index-only changes.
                const diff = unstaged === undefined ? diffs.get(path) : undefined;
                const hasCounts = diff?.additions !== undefined && diff.deletions !== undefined;

                return (
                    <li key={path}>
                        <Button
                            variant="filling"
                            color="secondary"
                            size="xs"
                            className={styles.file}
                            contentClassName={styles.fileContent}
                            aria-label={`Show diff for ${path}`}
                            onPress={() => model.showUncommittedFile(path)}
                        >
                            <Text color={conflicts ? 'danger' : 'success'} className={styles.mark} aria-hidden="true">
                                {conflicts ? <Close size={12} /> : <Check size={12} />}
                            </Text>
                            <Text variant="xs" truncate className={styles.name} title={path}>
                                {name}
                            </Text>
                            {hasCounts && (
                                <span className={styles.counts}>
                                    <Text variant="xs" color="success">{`+${diff.additions}`}</Text>
                                    <Text variant="xs" color="danger">{`−${diff.deletions}`}</Text>
                                </span>
                            )}
                        </Button>
                    </li>
                );
            })}
        </ul>
    );
}

/** Git owns the merge index. Conflicting paths and paths already staged for the merge appear in separate lists. */
export function MergeFiles({
    model,
    status,
    writing,
}: {
    model: PlaceChanges;
    status: Extract<GitStatus, { isRepository: true }>;
    writing: boolean;
}) {
    const remote = useRemoteActions(model.facts);
    const ui = useProjectUi();
    if (!status.merging) return null;

    const count = status.merging.conflicts;
    const conflicts = status.entries.filter(entry => entry.unstaged === 'conflicted');
    const staged = status.entries.filter(entry => entry.staged !== undefined && entry.unstaged !== 'conflicted');

    const ask = () => {
        const quote =
            conflicts.length === 0
                ? 'Resolve the merge conflicts'
                : `Resolve the merge conflicts in:\n${conflicts.map(({ path }) => `- \`${path}\``).join('\n')}`;

        if (quoteIntoComposer(quote)) ui.showChat();
    };

    return (
        <>
            <Text as="h3" variant="sm" weight="medium" className={styles.title}>
                Changes
            </Text>
            {count > 0 && (
                <FileGroup label="Conflicts" count={count} conflict>
                    <div className={styles.actions}>
                        <Button
                            variant="filled"
                            color="secondary"
                            size="xs"
                            aria-label="Ask agent to resolve conflicts"
                            onPress={ask}
                        >
                            Ask agent
                        </Button>
                        <Button
                            variant="filling"
                            color="secondary"
                            size="xs"
                            isDisabled={writing || remote.busy}
                            isPending={remote.running === 'abort'}
                            onPress={() =>
                                confirmAbortMerge(async () => {
                                    await remote.run('abort');
                                })
                            }
                        >
                            Abort merge
                        </Button>
                    </div>
                    <MergeFileList model={model} entries={conflicts} conflicts />
                    {conflicts.length < count && (
                        <Text variant="xs" color="secondary">
                            Showing {conflicts.length} of {count} conflicts
                        </Text>
                    )}
                </FileGroup>
            )}
            <FileGroup label="Staged" count={staged.length}>
                <MergeFileList model={model} entries={staged} />
                {status.truncated ? (
                    <Text variant="xs" color="secondary">
                        Showing staged files from the first {status.entries.length} changed files
                    </Text>
                ) : staged.length === 0 ? (
                    <Text variant="xs" color="secondary">
                        No staged files
                    </Text>
                ) : null}
            </FileGroup>
        </>
    );
}
