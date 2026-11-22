import { Button } from '@clowdy/components/Button';
import { For } from '@clowdy/components/For';
import { PanelEmptyState, PanelLoadingState } from '@clowdy/components/Panel';
import { Show } from '@clowdy/components/Show';
import { Tab, TabStrip } from '@clowdy/components/TabStrip';
import { Text } from '@clowdy/components/Text';
import { Terminal } from '@clowdy/icons/14';
import { Plus } from '@clowdy/icons/16';
import { useEffect, useRef } from 'react';

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
 * are there when the tab comes back.
 */
export function TerminalShell({ session }: { session: TerminalSession }) {
    const { transport } = useRootStore();
    const store = useTerminalsStore();
    const hostRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const host = hostRef.current;

        if (!host) return;

        const view = session.view instanceof TerminalView ? session.view : new TerminalView(session, { transport, onGone: () => store.forget(session) });

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
    }, [session, store, transport]);

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

function TerminalBar({ projectId, folderId }: { projectId: ProjectId; folderId: FolderId }) {
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
                        onClose={ () => void store.close(session) }
                    />
                ) }
            </For>
        </TabStrip>
    );
}

/**
 * The side panel's Terminal tab: the shells the daemon runs in the folder the window is working in (the same folder the Info and Files tabs name), a tab for each,
 * and the one that is chosen drawn below. The shells belong to the daemon, so they outlive the tab, a reload of the window and, when the daemon is on another
 * machine, the connection; the first look at a folder starts one so that the tab opens on a prompt.
 */
export default function TerminalTab() {
    const project = useProjectState();
    const ui = useProjectUi();
    const store = useTerminalsStore();
    const projectId = project.project.id;
    const folder = currentFolder(project, ui);
    const active = store.activeOf(projectId, folder.id);

    useEffect(() => {
        void store.load(projectId).then(() => store.ensureOne(projectId, folder.id));
    }, [store, projectId, folder.id]);

    return (
        <div className={ styles.root }>
            <TerminalBar projectId={ projectId } folderId={ folder.id } />
            <div className={ styles.stage }>
                <Show
                    when={ active }
                    fallback={
                        <Show when={ store.isLoaded(projectId) } fallback={ <PanelLoadingState /> }>
                            <PanelEmptyState
                                title="No terminals"
                                description={ store.error || undefined }
                                action={ <Button size="sm" variant="filled" color="secondary" onPress={ () => void store.start(projectId, folder.id) }>New terminal</Button> }
                            />
                        </Show>
                    }
                >
                    { session => <TerminalShell key={ session.id } session={ session } /> }
                </Show>
            </div>
        </div>
    );
}
