import { useCallback, useEffect, useRef, useState } from 'react';

import { useRootStore } from '../../../stores';

import type { ProjectId, ProjectInfo } from '@clowdy/protocol';

/** How often the page asks again while it is open: agents start and stop, and the folder or its remote may change outside Clowdy. */
const POLL_MS = 10_000;

/**
 * What the daemon reads about each project (`getProjectsInfo`): asked when the page opens, when the list of projects changes and every
 * ten seconds while the window is visible. A failed read keeps what was known, and `failed` says the last one did.
 */
export function useProjectsInfo(): { info: ReadonlyMap<ProjectId, ProjectInfo>; failed: boolean } {
    const root = useRootStore();
    const [info, setInfo] = useState<ReadonlyMap<ProjectId, ProjectInfo>>(new Map());
    const [failed, setFailed] = useState(false);
    const latest = useRef(0);
    // A changed list (a project added, removed or renamed) makes what was read out of date.
    const { projects } = root;

    const reload = useCallback(() => {
        const request = ++latest.current;

        root.transport.getProjectsInfo().then(
            (entries) => {
                if (request !== latest.current) return;

                setInfo(new Map(entries.map(entry => [entry.projectId, entry])));
                setFailed(false);
            },
            () => {
                if (request === latest.current) setFailed(true);
            }
        );
    }, [root]);

    useEffect(() => {
        reload();
    }, [reload, projects]);

    useEffect(() => {
        const timer = setInterval(() => {
            if (!document.hidden) reload();
        }, POLL_MS);

        return () => {
            clearInterval(timer);
            // An answer that arrives after the page is gone must not set state.
            latest.current++;
        };
    }, [reload]);

    return { info, failed };
}
