import { useCallback, useEffect, useRef, useState } from 'react';

import { nativeWheel } from '../../gestures/nativeWheel';
import { Unreachable } from '../../shell/Unreachable';
import { ProjectProvider, useProjectState, useProjectUi, useRootStore } from '../../stores';
import { AgentList } from './AgentList';
import { resolveSelection, visibleChats } from './agentTree';
import styles from './ProjectSidebar.module.css';
import { useSidebarWorktrees } from './useSidebarWorktrees';

import type { FolderWorktrees, ProjectInfo } from '@clowdy/protocol';
import type { ReactNode } from 'react';
import type { ProjectState } from '../../stores';

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
    const ordered = [
        ...root.projects.filter(project => project.personal),
        ...root.projects.filter(project => !project.personal),
    ];
    const index = ordered.findIndex(project => project.id === current.id);
    const previous = ordered[index - 1]?.id;
    const next = ordered[index + 1]?.id;
    const [, refresh] = useState(0);
    const [offset, setOffset] = useState(0);
    const [settling, setSettling] = useState(false);
    const [previewSide, setPreviewSide] = useState(0);
    const worktrees = useRef(new Map<string, FolderWorktrees[]>());
    const shown = useRef<string | undefined>(undefined);
    const viewport = useRef<HTMLDivElement>(null);
    const gesture = useRef({ x: 0, y: 0, locked: false, touchX: 0, touchY: 0, mode: '' });
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const unlockTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const commitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const currentId = current.id;
    const orderKey = ordered.map(project => project.id).join('\u0000');
    const rememberWorktrees = useCallback((id: string, data: FolderWorktrees[] | undefined) => {
        if (data) worktrees.current.set(id, data);
        else worktrees.current.delete(id);
    }, []);

    useEffect(() => {
        if (previous) root.prepareProject(previous);
        if (next) root.prepareProject(next);
        refresh(value => value + 1);
    }, [root, previous, next]);

    useEffect(() => {
        clearTimeout(timer.current);
        clearTimeout(commitTimer.current);
        Object.assign(gesture.current, { x: 0, y: 0, touchX: 0, touchY: 0, mode: '' });
        if (gesture.current.locked) {
            clearTimeout(unlockTimer.current);
            unlockTimer.current = setTimeout(() => {
                gesture.current.locked = false;
            }, 400);
        }
        setOffset(0);
        setSettling(false);
        setPreviewSide(0);
        shown.current = undefined;
    }, [currentId, orderKey]);

    useEffect(() => {
        const node = viewport.current;
        if (!node) return;
        const state = gesture.current;
        const width = () => node.clientWidth || 270;
        const neighbor = (x: number) => (x > 0 ? previous : next);
        const move = (x: number) => {
            const target = neighbor(x);
            // Worktree details are optional for the selected panel too. A failed read must not
            // prevent reaching a project; the preview can fill them in when the read succeeds.
            const status = target && root.projectState(target)?.status;
            const ready = status === 'ready' || status === 'failed';
            shown.current = ready ? target : undefined;
            setPreviewSide(ready ? (x > 0 ? -1 : 1) : 0);
            setOffset(ready ? Math.max(-width(), Math.min(width(), x)) : Math.max(-32, Math.min(32, x * 0.15)));
        };
        const finish = () => {
            const target = neighbor(state.x);
            const accept =
                Math.abs(state.x) >= width() * 0.35 &&
                target &&
                shown.current === target &&
                ['ready', 'failed'].includes(root.projectState(target)?.status ?? '');
            state.locked = true;
            setSettling(true);
            setOffset(accept ? Math.sign(state.x) * width() : 0);
            const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
            commitTimer.current = setTimeout(
                () => {
                    if (
                        accept &&
                        root.selectedProjectId === currentId &&
                        root.projects.some(project => project.id === target)
                    )
                        root.selectProject(target);
                    setOffset(0);
                    setSettling(false);
                    setPreviewSide(0);
                    shown.current = undefined;
                    state.x = 0;
                    state.y = 0;
                    state.mode = '';
                    // Continue swallowing the tail of the same wheel gesture until it has gone quiet.
                    clearTimeout(unlockTimer.current);
                    unlockTimer.current = setTimeout(() => {
                        state.locked = false;
                    }, 400);
                },
                reduced ? 0 : 200
            );
        };
        const lifecycle = nativeWheel(node, release => {
            clearTimeout(timer.current);
            if (state.mode !== 'wheel') return;
            if (!release) state.x = 0;
            finish();
        });
        const wheel = (event: WheelEvent) => {
            if (event.ctrlKey || event.shiftKey || event.defaultPrevented || (!event.deltaX && !event.deltaY)) return;
            if (state.mode !== 'wheel') {
                for (
                    let child = event.target instanceof Element ? event.target : null;
                    child && child !== node;
                    child = child.parentElement
                ) {
                    const overflow = getComputedStyle(child).overflowX;
                    if (
                        (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') &&
                        child.scrollWidth > child.clientWidth + 1 &&
                        (event.deltaX < 0
                            ? child.scrollLeft > 1
                            : child.scrollLeft + child.clientWidth < child.scrollWidth - 1)
                    )
                        return;
                }
            }
            const mode = lifecycle.wheel(event);
            if (mode === 'momentum') {
                if (state.mode === 'wheel' && Math.abs(event.deltaX) > Math.abs(event.deltaY)) event.preventDefault();
                return;
            }
            if (mode === 'ignore') return;
            const scale =
                event.deltaMode === WheelEvent.DOM_DELTA_LINE
                    ? 16
                    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
                      ? width()
                      : 1;
            const dx = event.deltaX * scale;
            if (state.locked) {
                if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
                    event.preventDefault();
                    clearTimeout(unlockTimer.current);
                    unlockTimer.current = setTimeout(() => {
                        state.locked = false;
                    }, 400);
                }
                return;
            }
            if (Math.abs(event.deltaY) > Math.abs(event.deltaX) * 1.3) {
                if (state.mode === 'wheel') {
                    clearTimeout(timer.current);
                    state.x = 0;
                    finish();
                }
                return;
            }
            if (state.mode !== 'wheel' && (Math.abs(dx) < 3 || Math.abs(event.deltaX) <= Math.abs(event.deltaY) * 1.3))
                return;
            if (!event.deltaX) return;
            event.preventDefault();
            state.mode = 'wheel';
            state.x -= dx;
            move(state.x);
            clearTimeout(timer.current);
            if (mode === 'fallback') timer.current = setTimeout(finish, 180);
        };
        const start = (event: TouchEvent) => {
            if (state.locked) return;
            if (event.touches.length !== 1) {
                if (state.mode === 'touch') {
                    state.x = 0;
                    finish();
                } else state.mode = '';
                return;
            }
            state.touchX = event.touches[0].clientX;
            state.touchY = event.touches[0].clientY;
            state.mode = 'pending';
        };
        const touchMove = (event: TouchEvent) => {
            if (state.mode !== 'pending' && state.mode !== 'touch') return;
            if (event.touches.length !== 1) {
                if (state.mode === 'touch') {
                    state.x = 0;
                    finish();
                } else state.mode = '';
                return;
            }
            const x = event.touches[0].clientX - state.touchX;
            const y = event.touches[0].clientY - state.touchY;
            if (state.mode === 'pending') {
                if (Math.max(Math.abs(x), Math.abs(y)) < 8) return;
                state.mode = Math.abs(x) > Math.abs(y) ? 'touch' : 'vertical';
            }
            if (state.mode !== 'touch') return;
            event.preventDefault();
            state.x = x;
            move(x);
        };
        const end = (event: TouchEvent) => {
            if (state.mode === 'touch') {
                if (event.touches.length) state.x = 0;
                finish();
            } else state.mode = '';
        };
        const cancel = () => {
            if (state.mode === 'touch') {
                state.x = 0;
                finish();
            } else state.mode = '';
        };
        const blur = () => {
            lifecycle.cancel();
            clearTimeout(timer.current);
            clearTimeout(commitTimer.current);
            Object.assign(state, { x: 0, y: 0, locked: false, mode: '' });
            shown.current = undefined;
            setOffset(0);
            setSettling(false);
            setPreviewSide(0);
        };
        lifecycle.onOutsideWheel(event => {
            if (state.mode !== 'wheel') return;
            if (
                event.target instanceof Element &&
                event.target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [data-modal-overlay]')
            ) {
                lifecycle.cancel();
                return;
            }
            wheel(event);
            if (event.defaultPrevented) event.stopPropagation();
        });
        window.addEventListener('blur', blur);
        node.addEventListener('wheel', wheel, { passive: false });
        node.addEventListener('touchstart', start, { passive: true });
        node.addEventListener('touchmove', touchMove, { passive: false });
        node.addEventListener('touchend', end);
        node.addEventListener('touchcancel', cancel);
        // A snap target is measured in pixels. If the sidebar is resized mid-gesture or
        // mid-animation, cancel it rather than committing at the old width.
        let lastWidth = node.clientWidth;
        const observer =
            typeof ResizeObserver === 'undefined'
                ? undefined
                : new ResizeObserver(() => {
                      if (node.clientWidth === lastWidth) return;
                      lastWidth = node.clientWidth;
                      lifecycle.cancel();
                      clearTimeout(timer.current);
                      clearTimeout(commitTimer.current);
                      clearTimeout(unlockTimer.current);
                      Object.assign(state, { x: 0, y: 0, locked: false, mode: '' });
                      shown.current = undefined;
                      setOffset(0);
                      setSettling(false);
                      setPreviewSide(0);
                  });
        observer?.observe(node);
        return () => {
            window.removeEventListener('blur', blur);
            node.removeEventListener('wheel', wheel);
            node.removeEventListener('touchstart', start);
            node.removeEventListener('touchmove', touchMove);
            node.removeEventListener('touchend', end);
            node.removeEventListener('touchcancel', cancel);
            observer?.disconnect();
            lifecycle.dispose();
            clearTimeout(timer.current);
            clearTimeout(commitTimer.current);
        };
    }, [root, currentId, previous, next, orderKey]);

    useEffect(() => () => clearTimeout(unlockTimer.current), []);

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
