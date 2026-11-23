import { useCallback, useEffect, useRef, useState } from 'react';

import { useRootStore } from '../../../stores';

import type { ProjectId, ProjectInfo } from '@clowdy/protocol';

/** How often the page asks again while it is open: agents start and stop, and the folder or its remote may change outside Clowdy. */
const POLL_MS = 10_000;

/**
 * What the daemon reads about each project (`getProjectsInfo`): asked when the page opens, when the list of projects changes and, unless `poll` is
 * off, every ten seconds while the window is visible. With `refreshOnFocus` it is asked again each time the window gets focus, for a page that does not poll but names what
 * changes while the app is in the background; with `reloadKey` it is asked again each time that value changes, for a page that knows of a change the daemon's answer must follow
 * (the first value is the page's opening, which reads anyway). A failed read keeps what was known, and `failed` says the last one did. With `enabled` off
 * nothing is read (a screen that needs the answer only sometimes).
 */
export function useProjectsInfo({ enabled = true, poll = true, refreshOnFocus = false, reloadKey }: { enabled?: boolean; poll?: boolean; refreshOnFocus?: boolean; reloadKey?: string } = {}): { info: ReadonlyMap<ProjectId, ProjectInfo>; failed: boolean } {
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
        if (enabled) reload();
    }, [enabled, reload, projects, reloadKey]);

    useEffect(() => {
        if (!enabled || !refreshOnFocus) return undefined;

        window.addEventListener('focus', reload);

        return () => window.removeEventListener('focus', reload);
    }, [enabled, refreshOnFocus, reload]);

    useEffect(() => {
        const timer = enabled && poll
            ? setInterval(() => {
                if (!document.hidden) reload();
            }, POLL_MS)
            : undefined;

        return () => {
            clearInterval(timer);
            // An answer that arrives after the page is gone must not set state.
            latest.current++;
        };
    }, [enabled, poll, reload]);

    return { info, failed };
}
