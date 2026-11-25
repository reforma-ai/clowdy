import { useCallback, useEffect, useRef, useState } from 'react';

import { useRootStore } from '../../../stores';
import { onFolderGitRefresh } from '../../openWith/useFolderGit';

import type { ProjectId, ProjectInfo } from '@clowdy/protocol';

/** How often the page asks again while it is open: agents start and stop, and the folder or its remote may change outside Clowdy. */
const POLL_MS = 10_000;
const HEAD_POLL_MS = 60_000;

/**
 * What the daemon reads about each project (`getProjectsInfo`): asked when the page opens, when the list of projects changes and, unless `poll` is
 * off, every ten seconds while the window is visible. With `refreshOnFocus` it is asked again each time the window gets focus, for a page that does not poll but names what
 * changes while the app is in the background; with `reloadKey` it is asked again each time that value changes, for a page that knows of a change the daemon's answer must follow
 * (the first value is the page's opening, which reads anyway). A failed read keeps what was known, and `failed` says the last one did. With `enabled` off
 * nothing is read (a screen that needs the answer only sometimes).
 */
export function useProjectsInfo({
    enabled = true,
    poll = true,
    refreshOnFocus = false,
    refreshProjectId,
    reloadKey,
}: {
    enabled?: boolean;
    poll?: boolean;
    refreshOnFocus?: boolean;
    /** Keep the current project's branch names fresh even when the full project list is not polled. */
    refreshProjectId?: ProjectId;
    reloadKey?: string;
} = {}): { info: ReadonlyMap<ProjectId, ProjectInfo>; failed: boolean } {
    const root = useRootStore();
    const [info, setInfo] = useState<ReadonlyMap<ProjectId, ProjectInfo>>(new Map());
    const [failed, setFailed] = useState(false);
    const latest = useRef(0);
    const sequence = useRef(0);
    const projectReads = useRef(new Map<ProjectId, number>());
    const projectAnswers = useRef(new Map<ProjectId, number>());
    const previousProject = useRef(refreshProjectId);
    // A changed list (a project added, removed or renamed) makes what was read out of date.
    const { projects } = root;

    const reload = useCallback(() => {
        const request = ++sequence.current;
        latest.current = request;

        root.transport.getProjectsInfo().then(
            entries => {
                if (request !== latest.current) return;

                setInfo(
                    known =>
                        new Map(
                            entries.map(entry => [
                                entry.projectId,
                                (projectAnswers.current.get(entry.projectId) ?? 0) > request
                                    ? (known.get(entry.projectId) ?? entry)
                                    : entry,
                            ])
                        )
                );
                setFailed(false);
            },
            () => {
                if (request === latest.current) setFailed(true);
            }
        );
    }, [root]);

    const reloadProject = useCallback(
        (projectId: ProjectId) => {
            const request = ++sequence.current;
            projectReads.current.set(projectId, request);
            root.transport.getProjectsInfo(projectId).then(
                entries => {
                    if (request < latest.current || projectReads.current.get(projectId) !== request) return;
                    const entry = entries.find(candidate => candidate.projectId === projectId);
                    if (!entry) return;
                    projectAnswers.current.set(projectId, request);
                    setInfo(known => new Map(known).set(projectId, entry));
                },
                () => undefined
            );
        },
        [root]
    );

    useEffect(() => {
        if (enabled) reload();
    }, [enabled, reload, projects, reloadKey]);

    useEffect(() => {
        if (!enabled || !refreshOnFocus) return undefined;

        window.addEventListener('focus', reload);

        return () => window.removeEventListener('focus', reload);
    }, [enabled, refreshOnFocus, reload]);

    useEffect(() => {
        const timer =
            enabled && poll
                ? setInterval(() => {
                      if (!document.hidden) reload();
                  }, POLL_MS)
                : undefined;

        return () => {
            clearInterval(timer);
            // An answer that arrives after the page is gone must not set state.
            latest.current = ++sequence.current;
        };
    }, [enabled, poll, reload]);

    useEffect(() => {
        if (!enabled || !refreshProjectId) return undefined;

        const refresh = () => {
            if (!document.hidden) reloadProject(refreshProjectId);
        };
        if (previousProject.current !== refreshProjectId) refresh();
        previousProject.current = refreshProjectId;
        const stop = onFolderGitRefresh(projectId => {
            if (projectId === refreshProjectId) refresh();
        });
        const timer = setInterval(refresh, HEAD_POLL_MS);
        return () => {
            stop();
            clearInterval(timer);
            projectReads.current.delete(refreshProjectId);
        };
    }, [enabled, refreshProjectId, reloadProject]);

    return { info, failed };
}
