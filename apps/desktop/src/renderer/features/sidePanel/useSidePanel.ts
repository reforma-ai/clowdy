import { useRootStore, type SidePanelTab } from '../../stores';

export interface SidePanelControl {
    /** The window shows a project's screen (Settings may be open over it), so the panel and the project's tabs of the rail can be there. */
    available: boolean;
    /** The rail at the window's right edge is drawn: the projects are loaded. It has Settings in it whether or not a project is on show. */
    railShown: boolean;
    /** The panel is drawn: it is open for the selected project, and the window can show it. */
    open: boolean;
    /** The tab the panel shows, or showed last: the project keeps it while the panel is shut. */
    tab: SidePanelTab;
    toggle: () => void;
    /** Opens the panel on a tab, or shuts it when that tab is the one it shows: what a click on the tab's item and the tab's key do. */
    toggleTab: (tab: SidePanelTab) => void;
}

/** The side panel of the selected project: whether it can be drawn, whether it is open, and how to flip it. */
export function useSidePanel(): SidePanelControl {
    const root = useRootStore();
    const ui = root.projectScreenReady && root.selectedProjectId ? root.ui.forProject(root.selectedProjectId) : undefined;

    return { available: ui !== undefined, railShown: root.phase === 'ready', open: ui?.sidePanelOpen === true, tab: ui?.sidePanelTab ?? 'info', toggle: () => ui?.toggleSidePanel(), toggleTab: tab => ui?.toggleSidePanelTab(tab) };
}
