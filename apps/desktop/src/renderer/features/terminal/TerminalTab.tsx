import { Button } from '@clowdy/components/Button';
import { For } from '@clowdy/components/For';
import { PanelLoadingState } from '@clowdy/components/Panel';
import { Show } from '@clowdy/components/Show';
import { Tab, TabStrip } from '@clowdy/components/TabStrip';
import { Text } from '@clowdy/components/Text';
import { toast } from '@clowdy/components/Toast';
import { Terminal } from '@clowdy/icons/14';
import { Plus } from '@clowdy/icons/16';
import { useCallback, useEffect, useRef } from 'react';

import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { currentFolder } from '../sidePanel/currentFolder';
import { terminalLabels } from './terminalLabels';
import styles from './TerminalTab.module.css';
import { TerminalView } from './TerminalView';
import { useTerminalsStore } from './useTerminalsStore';

import '@xterm/xterm/css/xterm.css';

import type { FolderId, ProjectId } from '@clowdy/protocol';
import type { TerminalSession } from './TerminalsStore';

/**
 * The shell that is chosen, with its banners. The xterm lives in the session's view and only moves between hosts here, so what was on the screen, and the scrollback,
 * are there when the tab comes back. `onEmptied` is told when the daemon takes the shell away and it was the folder's last.
 */
export function TerminalShell({ session, onEmptied }: { session: TerminalSession; onEmptied?: () => void }) {
    const { transport } = useRootStore();
    const store = useTerminalsStore();
    const hostRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const host = hostRef.current;

        if (!host) return;

        const view = session.view instanceof TerminalView ? session.view : new TerminalView(session, {
            transport,
            onGone: () => {
                store.forget(session);

                if (store.sessionsOf(session.info.projectId, session.info.folderId).length === 0) onEmptied?.();
            },
        });

        session.view = view;
        view.mount(host);

        const resize = new ResizeObserver(() => view.fit());
        // The xterm paints its own colors: the theme is a class on <html>.
        const theme = new MutationObserver(() => view.syncTheme());

        resize.observe(host);
        theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

        return () => {
            resize.disconnect();
            theme.disconnect();
            view.unmount();
        };
    }, [session, store, transport, onEmptied]);

    return (
        <>
            <div ref={ hostRef } className={ styles.host } data-terminal="" />
            <Show when={ session.status === 'reconnecting' }>
                <div className={ styles.banner }>
                    <Text variant="sm" color="secondary">Reconnecting</Text>
                </div>
            </Show>
            <Show when={ !session.isRunning }>
                <div className={ styles.banner }>
                    <Text variant="sm" color="secondary">Process exited</Text>
                    <Button size="xs" variant="filled" color="secondary" onPress={ () => void store.start(session.info.projectId, session.info.folderId) }>New terminal</Button>
                </div>
            </Show>
        </>
    );
}

/** The tabs of the folder's shells; `onEmptied` is told when closing a shell left the folder with none. */
function TerminalBar({ projectId, folderId, onEmptied }: { projectId: ProjectId; folderId: FolderId; onEmptied: () => void }) {
    const store = useTerminalsStore();
    const sessions = store.sessionsOf(projectId, folderId);
    const active = store.activeOf(projectId, folderId);
    const labels = terminalLabels(sessions.map(session => session.info));

    return (
        <TabStrip
            aria-label="Terminals"
            end={
                <Button className={ styles.add } size="sm" variant="filling" color="secondary" iconOnly tooltip="New terminal" tooltipPlacement="bottom" aria-label="New terminal" onPress={ () => void store.start(projectId, folderId) }>
                    <Plus aria-hidden="true" />
                </Button>
            }
        >
            <For each={ sessions }>
                { (session, index) => (
                    <Tab
                        key={ session.id }
                        label={ labels[index] }
                        icon={ <Terminal aria-hidden="true" /> }
                        active={ session === active }
                        closeLabel={ `Close ${ labels[index] }` }
                        onSelect={ () => store.select(session) }
                        onClose={ () => {
                            // The shell is gone from the list at once; the daemon is told meanwhile.
                            void store.close(session);

                            if (store.sessionsOf(projectId, folderId).length === 0) onEmptied();
                        } }
                    />
                ) }
            </For>
        </TabStrip>
    );
}

/**
 * The side panel's Terminal tab: the shells the daemon runs in the folder the window is working in (the same folder the Info and Files tabs name), a tab for each,
 * and the one that is chosen drawn below. The shells belong to the daemon, so they outlive the tab, a reload of the window and, when the daemon is on another
 * machine, the connection. The tab is never open on nothing: looking at a folder that has no shell starts one, and closing the last one shuts the panel. When no
 * shell can be started, a toast says why and the panel shuts.
 */
export default function TerminalTab() {
    const project = useProjectState();
    const ui = useProjectUi();
    const store = useTerminalsStore();
    const projectId = project.project.id;
    const folder = currentFolder(project, ui);
    const active = store.activeOf(projectId, folder.id);
    const shutIfEmpty = useCallback(() => {
        if (store.sessionsOf(projectId, folder.id).length === 0) ui.closeSidePanel();
    }, [store, ui, projectId, folder.id]);

    useEffect(() => {
        // A tab that went before the shells were read has nothing to start for.
        let current = true;

        void store.load(projectId)
            .then(() => (current ? store.ensureOne(projectId, folder.id) : undefined))
            .then((session) => {
                if (!current || session) return;

                toast.error({ title: 'Couldn’t start a terminal', message: store.error || undefined });
                ui.closeSidePanel();
            });

        return () => {
            current = false;
        };
    }, [store, ui, projectId, folder.id]);

    return (
        <div className={ styles.root }>
            <TerminalBar projectId={ projectId } folderId={ folder.id } onEmptied={ shutIfEmpty } />
            <div className={ styles.stage }>
                <Show when={ active } fallback={ <PanelLoadingState /> }>
                    { session => <TerminalShell key={ session.id } session={ session } onEmptied={ shutIfEmpty } /> }
                </Show>
            </div>
        </div>
    );
}
