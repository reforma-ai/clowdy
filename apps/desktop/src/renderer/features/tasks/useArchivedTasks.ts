import { useEffect, useRef, useState } from 'react';

import { useProjectState, useRootStore } from '../../stores';

import type { Task } from '@clowdy/protocol';
import type { Transport } from '../../daemon/transport';

/** How many archived tasks a page holds: a "Show more" press loads this many more. The daemon gives at most 100. */
export const ARCHIVE_PAGE_SIZE = 50;

/** The most the daemon gives in one read. */
const MAX_READ = 100;

/**
 * How long a change of the archive waits before the archive is read again: an archive of a tree sends an event for each task of it, and one read answers them all.
 * Not for the first read, which is made at once.
 */
export const RELOAD_DELAY_MS = 120;

export type ArchivedTasks =
    | { status: 'loading' }
    | { status: 'failed'; message: string }
    | {
          status: 'ready';
          /** The tasks loaded, newest archived first. */
          tasks: Task[];
          /** How many the project has in the archive, loaded or not. */
          total: number;
          /** More pages follow; `loadMore` reads the next. */
          hasMore: boolean;
          isLoadingMore: boolean;
          /** Why the last `loadMore` failed. The list loaded so far stays. */
          moreFailed?: string;
      };

/** What the hook keeps of the daemon's pages: the cursor of the next one is the daemon's, so the list is never cut or repeated by what changes meanwhile. */
interface Loaded {
    tasks: Task[];
    total: number;
    cursor: string | undefined;
}

/** Reads pages from the start until `wanted` tasks are in, or the archive ends. */
async function readFromStart(transport: Transport, projectId: string, wanted: number): Promise<Loaded> {
    const tasks: Task[] = [];
    let total = 0;
    let cursor: string | undefined;

    do {
        const page = await transport.getArchivedTasks(projectId, {
            limit: Math.min(MAX_READ, Math.max(wanted - tasks.length, 1)),
            cursor,
        });

        tasks.push(...page.tasks);
        total = page.total;
        cursor = page.nextCursor;
    } while (cursor !== undefined && tasks.length < wanted);

    return { tasks, total, cursor };
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The project's archived tasks, read from the daemon `pageSize` at a time (`loadMore` is the next page), newest archived first. The first read shows `loading`, and a failed one
 * `failed` with `retry`. What the archive holds changes under the view (a restore, an archive from a chat or the command line, a delete), and the project says so
 * (`ProjectState.archiveRevision`): the view then reads again as many tasks as it shows, after a short pause, and swaps them in without clearing the list; a read that fails
 * leaves what is shown, and the next change tries again. Every task read is remembered by the project (`rememberArchived`), so a key or an id of one resolves elsewhere too.
 */
export function useArchivedTasks(pageSize = ARCHIVE_PAGE_SIZE): {
    state: ArchivedTasks;
    loadMore: () => void;
    retry: () => void;
} {
    const { transport } = useRootStore();
    const project = useProjectState();
    const { archiveRevision } = project;
    const [state, setState] = useState<ArchivedTasks>({ status: 'loading' });
    const [attempt, setAttempt] = useState(0);
    // What the latest render shows, which `loadMore` and the next reload read; `generation` drops the answer of a read that a newer reload has overtaken.
    const shown = useRef<Loaded | undefined>(undefined);
    const generation = useRef(0);

    const show = (loaded: Loaded, extra: Partial<Extract<ArchivedTasks, { status: 'ready' }>> = {}) => {
        shown.current = loaded;
        setState({
            status: 'ready',
            tasks: loaded.tasks,
            total: loaded.total,
            hasMore: loaded.cursor !== undefined,
            isLoadingMore: false,
            ...extra,
        });
    };

    useEffect(() => {
        const mine = ++generation.current;
        const isReload = shown.current !== undefined;
        const timer = setTimeout(
            () => {
                readFromStart(transport, project.id, Math.max(pageSize, shown.current?.tasks.length ?? 0)).then(
                    loaded => {
                        if (mine !== generation.current) return;

                        project.rememberArchived(loaded.tasks);
                        show(loaded);
                    },
                    error => {
                        if (mine !== generation.current) return;

                        // A list that is on show stays; a "Show more" that this read overtook is not waiting for a page that will not come.
                        if (!shown.current) setState({ status: 'failed', message: messageOf(error) });
                        else
                            setState(current =>
                                current.status === 'ready' && current.isLoadingMore
                                    ? { ...current, isLoadingMore: false }
                                    : current
                            );
                    }
                );
            },
            isReload ? RELOAD_DELAY_MS : 0
        );

        return () => clearTimeout(timer);
    }, [transport, project, pageSize, archiveRevision, attempt]);

    const loadMore = () => {
        const loaded = shown.current;

        if (!loaded || loaded.cursor === undefined) return;

        const mine = generation.current;

        setState(current =>
            current.status === 'ready' ? { ...current, isLoadingMore: true, moreFailed: undefined } : current
        );
        transport.getArchivedTasks(project.id, { limit: Math.min(MAX_READ, pageSize), cursor: loaded.cursor }).then(
            page => {
                // A reload came in meanwhile and brought the list up to date, this page included or not.
                if (mine !== generation.current) return;

                const known = new Set(loaded.tasks.map(task => task.id));

                project.rememberArchived(page.tasks);
                show({
                    tasks: [...loaded.tasks, ...page.tasks.filter(task => !known.has(task.id))],
                    total: page.total,
                    cursor: page.nextCursor,
                });
            },
            error => {
                if (mine === generation.current)
                    setState(current =>
                        current.status === 'ready'
                            ? { ...current, isLoadingMore: false, moreFailed: messageOf(error) }
                            : current
                    );
            }
        );
    };

    const retry = () => {
        shown.current = undefined;
        setState({ status: 'loading' });
        setAttempt(count => count + 1);
    };

    return { state, loadMore, retry };
}
