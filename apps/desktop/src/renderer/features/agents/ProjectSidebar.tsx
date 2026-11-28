import { useCallback, useEffect, useRef, useState } from 'react';

import { attachHorizontalSwipe } from '../../gestures/horizontalSwipe';
import { swipeDecision } from '../../gestures/swipeTracker';
import { Unreachable } from '../../shell/Unreachable';
import { ProjectProvider, useProjectState, useProjectUi, useRootStore } from '../../stores';
import { AgentList } from './AgentList';
import { resolveSelection, visibleChats } from './agentTree';
import styles from './ProjectSidebar.module.css';
import { useSidebarWorktrees } from './useSidebarWorktrees';

import type { FolderWorktrees, ProjectInfo } from '@clowdy/protocol';
import type { ReactNode } from 'react';
import type { ProjectState, RootStore } from '../../stores';

/** The personal space comes first, then the others in their order. */
function neighborsOf(root: RootStore, id: string | null | undefined) {
    const ordered = [
        ...root.projects.filter(project => project.personal),
        ...root.projects.filter(project => !project.personal),
    ];
    const index = ordered.findIndex(project => project.id === id);
    return {
        previous: index < 0 ? undefined : ordered[index - 1]?.id,
        next: index < 0 ? undefined : ordered[index + 1]?.id,
    };
}

function PrepareWorktrees({ onRead }: { onRead: (id: string, data: FolderWorktrees[] | undefined) => void }) {
    const project = useProjectState();
    const ui = useProjectUi();
    const data = useSidebarWorktrees(ui.groupByWorktree);
    useEffect(() => {
        onRead(project.id, data);
        return () => onRead(project.id, undefined);
    }, [project.id, data, onRead]);
    return null;
}

function Preview({
    project,
    info,
    covered,
    worktrees,
}: {
    project: ProjectState;
    info?: ProjectInfo;
    covered: boolean;
    worktrees?: FolderWorktrees[];
}) {
    const ui = useProjectUi();
    const chats = visibleChats([...project.chats.values()], ui.chatOrder);
    const selection = resolveSelection(project.chats, chats, project.runs, ui.chatId, ui.runId, ui.draft);
    const missing = new Set(info?.folders.filter(folder => !folder.exists).map(folder => folder.folderId));

    return (
        <AgentList
            selection={selection}
            chats={chats}
            missing={missing}
            isCovered={covered}
            projectInfo={info}
            sidebarWorktrees={worktrees}
            preview
        />
    );
}

/** The selected panel and its immediate neighbors share a viewport, while the main screen keeps its selection. */
export function ProjectSidebar({
    children,
    info,
    covered,
}: {
    children: ReactNode;
    info: ReadonlyMap<string, ProjectInfo>;
    covered: boolean;
}) {
    const root = useRootStore();
    const current = useProjectState();
    const { previous, next } = neighborsOf(root, current.id);
    const [, refresh] = useState(0);
    const [offset, setOffset] = useState(0);
    const [settling, setSettling] = useState(false);
    const [previewSide, setPreviewSide] = useState(0);
    const worktrees = useRef(new Map<string, FolderWorktrees[]>());
    const shown = useRef<string | undefined>(undefined);
    const viewport = useRef<HTMLDivElement>(null);
    const track = useRef<HTMLDivElement>(null);
    const swipe = useRef<ReturnType<typeof attachHorizontalSwipe> | undefined>(undefined);
    // The animation after a release, until it commits or a new gesture picks it up.
    const settle = useRef<{ direction: number; target: string | undefined } | undefined>(undefined);
    // The project this component selected itself (a commit, or a new gesture finishing the one it interrupted): its
    // arrival is not a change from elsewhere, so it must not cancel a gesture that has already begun.
    const own = useRef<string | undefined>(undefined);
    const target = useRef(0);
    const commitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const currentId = current.id;
    const orderKey = root.projects.map(project => `${project.id}:${project.personal ? 1 : 0}`).join('\u0000');
    const rememberWorktrees = useCallback((id: string, data: FolderWorktrees[] | undefined) => {
        if (data) worktrees.current.set(id, data);
        else worktrees.current.delete(id);
    }, []);

    useEffect(() => {
        if (previous) root.prepareProject(previous);
        if (next) root.prepareProject(next);
        refresh(value => value + 1);
    }, [root, previous, next]);

    const place = useCallback((value: number, animate: boolean) => {
        target.current = value;
        setOffset(value);
        setSettling(animate);
    }, []);
    const rest = useCallback(() => {
        clearTimeout(commitTimer.current);
        settle.current = undefined;
        shown.current = undefined;
        place(0, false);
        setPreviewSide(0);
    }, [place]);

    useEffect(() => {
        const mine = own.current === currentId;
        own.current = undefined;
        if (mine) return;
        // The selection or the order changed from elsewhere: drop whatever was in flight.
        swipe.current?.cancel();
        rest();
    }, [currentId, orderKey, rest]);

    useEffect(() => {
        const node = viewport.current;
        if (!node) return;
        const width = () => node.clientWidth || 270;
        const ready = (id: string | undefined) => {
            const status = id && root.projectState(id)?.status;
            // Worktree details are optional for the selected panel too. A failed read must not
            // prevent reaching a project; the preview can fill them in when the read succeeds.
            return status === 'ready' || status === 'failed';
        };
        const neighbor = (x: number) => {
            const around = neighborsOf(root, root.selectedProjectId);
            return x > 0 ? around.previous : around.next;
        };
        /** Where the track is on screen now, mid-animation included. */
        const visible = () => {
            const transform = track.current ? getComputedStyle(track.current).transform : 'none';
            if (!transform || transform === 'none' || typeof DOMMatrixReadOnly === 'undefined') return target.current;
            try {
                return new DOMMatrixReadOnly(transform).m41;
            } catch {
                return target.current;
            }
        };
        const settleTo = (direction: number, id: string | undefined) => {
            clearTimeout(commitTimer.current);
            settle.current = { direction, target: id };
            place(direction * width(), true);
            const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
            const from = root.selectedProjectId;
            commitTimer.current = setTimeout(
                () => {
                    const pending = settle.current;
                    if (
                        direction &&
                        id &&
                        root.selectedProjectId === from &&
                        root.projects.some(project => project.id === id)
                    ) {
                        own.current = id;
                        // The list is already in place: it comes to rest with the switch, which the window may apply a
                        // frame later, while the chat fades over. Until then the switch is still pending, and a gesture
                        // that begins meanwhile finishes it itself; then this one must not move the list again.
                        root.selectProject(id, { after: () => settle.current === pending && rest() });
                        return;
                    }
                    rest();
                },
                reduced ? 0 : 200
            );
        };
        const controller = attachHorizontalSwipe(node, {
            start() {
                const interrupted = settle.current;
                if (!interrupted) return 0;
                // Catch the content where the animation has it, and finish its switch now.
                clearTimeout(commitTimer.current);
                settle.current = undefined;
                const at = visible();
                const { direction, target: id } = interrupted;
                if (direction && id && root.projects.some(project => project.id === id)) {
                    own.current = id;
                    shown.current = undefined;
                    // The fingers are already moving the new project's list: no frame may pass before it is drawn.
                    root.selectProject(id, { instant: true });
                    return at - direction * width();
                }
                return at;
            },
            move(x) {
                const id = neighbor(x);
                const reachable = ready(id);
                shown.current = reachable ? id : undefined;
                setPreviewSide(reachable ? (x > 0 ? -1 : 1) : 0);
                place(
                    reachable ? Math.max(-width(), Math.min(width(), x)) : Math.max(-32, Math.min(32, x * 0.15)),
                    false
                );
            },
            release(x, velocity) {
                const id = neighbor(x);
                const direction = swipeDecision(x, velocity, width());
                settleTo(direction && id && shown.current === id && ready(id) ? direction : 0, id);
            },
            cancel() {
                settleTo(0, undefined);
            },
        });
        swipe.current = controller;
        // A snap target is measured in pixels. If the sidebar is resized mid-gesture or
        // mid-animation, cancel it rather than committing at the old width.
        let lastWidth = node.clientWidth;
        const observer =
            typeof ResizeObserver === 'undefined'
                ? undefined
                : new ResizeObserver(() => {
                      if (node.clientWidth === lastWidth) return;
                      lastWidth = node.clientWidth;
                      controller.cancel();
                      rest();
                  });
        observer?.observe(node);
        return () => {
            observer?.disconnect();
            controller.dispose();
            swipe.current = undefined;
            clearTimeout(commitTimer.current);
        };
    }, [root, place, rest]);

    const panel = (id: string | undefined, side: number) => {
        const project = id ? root.projectState(id) : undefined;
        if (previewSide !== side || !project || project.status === 'loading') return null;
        return (
            <div className={styles.panel} style={{ left: `${side * 100}%` }} inert aria-hidden="true">
                {project.status === 'failed' ? (
                    <Unreachable message={project.error} onRetry={() => {}} />
                ) : (
                    <ProjectProvider value={project}>
                        <Preview
                            project={project}
                            info={info.get(project.id)}
                            covered={covered}
                            worktrees={worktrees.current.get(project.id)}
                        />
                    </ProjectProvider>
                )}
            </div>
        );
    };
    return (
        <div className={styles.viewport} ref={viewport} data-project-sidebar>
            {[previous, next].map(id => {
                const project = id ? root.projectState(id) : undefined;
                return project ? (
                    <ProjectProvider key={id} value={project}>
                        <PrepareWorktrees onRead={rememberWorktrees} />
                    </ProjectProvider>
                ) : null;
            })}
            <div
                ref={track}
                className={styles.track}
                style={{
                    transform: `translateX(${offset}px)`,
                    transition: settling ? 'transform 200ms ease-out' : 'none',
                }}
            >
                {panel(previous, -1)}
                <div className={styles.panel}>{children}</div>
                {panel(next, 1)}
            </div>
        </div>
    );
}
