import { Alert, AlertAction, AlertDescription, AlertIcon } from '@clowdy/components/Alert';
import { Button } from '@clowdy/components/Button';
import { Loader } from '@clowdy/components/Loader';
import { Text } from '@clowdy/components/Text';
import { ChevronDown, ChevronRight } from '@clowdy/icons/8';
import { AttentionCircle, Undo } from '@clowdy/icons/14';
import { type CSSProperties, useEffect, useRef, useState } from 'react';

import { useProjectState, useRootStore } from '../../stores';
import styles from './ArchiveView.module.css';
import { restoreTask } from './archiveActions';
import { type ArchiveBatch, archiveBatches, offersRestore } from './archiveBatches';
import { StatusPill } from './status';
import { TaskTree } from './taskTree';
import { formatAgo } from './taskView';
import { ARCHIVE_PAGE_SIZE, useArchivedTasks } from './useArchivedTasks';

import type { Task, TaskId, TaskStatus } from '@clowdy/protocol';

export interface ArchiveViewProps {
    statuses: readonly TaskStatus[];
    /** The task the detail panel shows. */
    openId: TaskId | null;
    /** A press on a task: show it in the panel, read only. */
    onOpen: (taskId: TaskId) => void;
    /** How many tasks a read brings. The daemon's page size; a test makes it small. */
    pageSize?: number;
}

/** A batch the focus leaves with a restore: the task restored, and the first task of the batch next to it, where the focus goes. */
interface Handoff {
    taskId: TaskId;
    nextId?: TaskId;
}

/** The row of an archived task under `scope`. */
const archivedRow = (scope: HTMLElement, taskId: TaskId) =>
    [...scope.querySelectorAll<HTMLElement>('[data-archived-task]')].find(row => row.dataset.archivedTask === taskId) ??
    null;

/** "3 archived tasks", or "Showing 50 of 120 archived tasks" while the rest is not loaded. */
const countLine = (shown: number, total: number) =>
    `${shown < total ? `Showing ${shown} of ${total}` : total} archived ${total === 1 ? 'task' : 'tasks'}`;

/**
 * The project's archive in place of the board or the list: its tasks in the batches they were archived in, the latest batch first, each a tree as the list draws one
 * (folds included, kept for the visit), read only. **Restore** is on the top of a batch, the task whose parent was not archived with it, when that parent is on the board
 * (`offersRestore`), and brings back everything that went with it; the batch leaves the view when the daemon's event says so, and the focus that sat on its Restore goes to the
 * next batch (else the one before it, else the heading of the empty view), never to the page's body. A press on a task opens it in the panel. The pages come `pageSize` at a time,
 * with **Show more**.
 */
export function ArchiveView({ statuses, openId, onOpen, pageSize = ARCHIVE_PAGE_SIZE }: ArchiveViewProps) {
    const { state, loadMore, retry } = useArchivedTasks(pageSize);
    const root = useRootStore();
    const project = useProjectState();
    const [folded, setFolded] = useState<ReadonlySet<TaskId>>(() => new Set());
    const [restoring, setRestoring] = useState<TaskId | null>(null);
    // The frame of the batches (or of the empty view), where the focus is looked for, and the Restore whose batch the focus has to leave with.
    const frame = useRef<HTMLDivElement>(null);
    const handoff = useRef<Handoff | null>(null);

    // The press that restored a batch had the focus, and the batch has left now: the focus would fall to the page's body. It goes on to the neighbour, unless the person moved it.
    useEffect(() => {
        const pending = handoff.current;
        const scope = frame.current;

        if (!pending || !scope || archivedRow(scope, pending.taskId)) return;

        handoff.current = null;

        if (document.activeElement && document.activeElement !== document.body) return;

        const next =
            (pending.nextId === undefined
                ? null
                : archivedRow(scope, pending.nextId)?.querySelector<HTMLElement>('[data-archive-open]')) ??
            scope.querySelector<HTMLElement>('[data-archive-open], [data-archive-heading]');

        next?.focus();
    });

    if (state.status === 'loading') {
        return (
            <div className={styles.center} role="status">
                <Loader size="xs" />
                <Text color="secondary">Loading the archive…</Text>
            </div>
        );
    }

    if (state.status === 'failed') {
        return (
            <div className={styles.center}>
                <Alert color="danger" className={styles.alert}>
                    <AlertIcon>
                        <AttentionCircle />
                    </AlertIcon>
                    <AlertDescription>{`The archive could not be loaded. ${state.message}`}</AlertDescription>
                    <AlertAction>
                        <Button size="sm" variant="bordered" onPress={retry}>
                            Retry
                        </Button>
                    </AlertAction>
                </Alert>
            </div>
        );
    }

    if (state.tasks.length === 0 && !state.hasMore) {
        return (
            <div ref={frame} className={styles.center}>
                <Text variant="heading-4" tabIndex={-1} className={styles.heading} data-archive-heading>
                    Nothing archived
                </Text>
                <Text color="secondary">Finished work you archive shows up here, and can be restored</Text>
            </div>
        );
    }

    const batches = archiveBatches(state.tasks);
    const toggle = (taskId: TaskId) =>
        setFolded(current => {
            const next = new Set(current);

            if (!next.delete(taskId)) next.add(taskId);

            return next;
        });

    const restore = async (task: Task, pressed: Element) => {
        const section = pressed.closest('section');
        const neighbour = section?.nextElementSibling ?? section?.previousElementSibling;

        // Only a focus that is on the batch has to follow it out.
        handoff.current = section?.contains(document.activeElement)
            ? {
                  taskId: task.id,
                  nextId: neighbour?.querySelector<HTMLElement>('[data-archived-task]')?.dataset.archivedTask,
              }
            : null;
        setRestoring(task.id);

        if (!(await restoreTask(root, project, task))) handoff.current = null;

        setRestoring(null);
    };

    const renderBatch = (batch: ArchiveBatch) => {
        const rows = new TaskTree(batch.tasks, statuses).rows(null, folded);

        return (
            <section
                key={batch.archivedAt}
                className={styles.batch}
                aria-label={`Archived ${formatAgo(batch.archivedAt, Date.now())}`}
            >
                <header className={styles.head}>
                    <Text variant="heading-6">{`Archived ${formatAgo(batch.archivedAt, Date.now())}`}</Text>
                    <span className={styles.count}>
                        {batch.tasks.length === 1 ? '1 task' : `${batch.tasks.length} tasks`}
                    </span>
                </header>

                <ul className={styles.rows}>
                    {rows.map(({ task, depth, hasChildren, collapsed }) => (
                        <li
                            key={task.id}
                            className={styles.row}
                            data-archived-task={task.id}
                            data-open={task.id === openId || undefined}
                            data-depth={depth}
                            style={{ '--depth': depth } as CSSProperties}
                        >
                            <span className={styles.fold}>
                                {hasChildren && (
                                    <button
                                        type="button"
                                        className={styles.chevron}
                                        aria-expanded={!collapsed}
                                        aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${task.key}`}
                                        onClick={() => toggle(task.id)}
                                    >
                                        {collapsed ? <ChevronRight /> : <ChevronDown />}
                                    </button>
                                )}
                            </span>
                            <button
                                type="button"
                                className={styles.open}
                                data-archive-open
                                aria-current={task.id === openId || undefined}
                                onClick={() => onOpen(task.id)}
                                title={task.title}
                            >
                                <span className={styles.key}>{task.key}</span>
                                <span className={styles.title}>{task.title}</span>
                            </button>
                            <span className={styles.status}>
                                <StatusPill status={statuses.find(status => status.id === task.statusId)} />
                            </span>
                            <span className={styles.action}>
                                {depth === 0 && offersRestore(task, id => project.tasks.has(id)) && (
                                    <Button
                                        size="xs"
                                        variant="bordered"
                                        className={styles.restore}
                                        aria-label={`Restore ${task.key}`}
                                        isPending={restoring === task.id}
                                        onPress={event => void restore(task, event.target)}
                                    >
                                        <Undo />
                                        Restore
                                    </Button>
                                )}
                            </span>
                        </li>
                    ))}
                </ul>
            </section>
        );
    };

    return (
        <div className={styles.view}>
            <div ref={frame} className={styles.batches}>
                {batches.map(batch => renderBatch(batch))}
            </div>

            <footer className={styles.foot}>
                <Text color="secondary">{countLine(state.tasks.length, state.total)}</Text>
                {state.moreFailed !== undefined && (
                    <Text color="secondary" role="alert">{`Couldn't load more. ${state.moreFailed}`}</Text>
                )}
                {state.hasMore && (
                    <Button size="sm" variant="bordered" isPending={state.isLoadingMore} onPress={loadMore}>
                        Show more
                    </Button>
                )}
            </footer>
        </div>
    );
}
