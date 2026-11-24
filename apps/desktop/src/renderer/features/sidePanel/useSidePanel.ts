import { type NoHalfReason, type SidePanelSize, type SidePanelTab, useRootStore } from '../../stores';

export interface SidePanelControl {
    /** The window shows a project's screen (Settings may be open over it), so the panel and the project's tabs of the rail can be there. */
    available: boolean;
    /** The rail at the window's right edge is drawn: the projects are loaded. It has Settings in it whether or not a project is on show. */
    railShown: boolean;
    /** The panel is drawn: it is open for the selected project, and the window can show it. */
    open: boolean;
    /** The tab the panel shows, or showed last: the project keeps it while the panel is shut. */
    tab: SidePanelTab;
    /** The panel is drawn in the place of the chat: it is open, and the project has it expanded or it shows the Tasks tab, which is always so. A shut panel is never expanded, and comes back expanded when the project has it so. */
    expanded: boolean;
    /** Why the tab the panel shows, or showed last, cannot be beside the chat, if it cannot: it is in the place of the chat whatever the project chose (Tasks always, Files, Docs and Changes in a window too narrow for them beside it). */
    noHalf: NoHalfReason | null;
    /** The tab is a list beside a view (Files, Docs, Changes), which needs more room than the other tabs while it is beside the chat. */
    tabHasTree: boolean;
    toggle: () => void;
    /** Sets the panel to one of the sizes the corner button's menu offers. */
    setSize: (size: SidePanelSize) => void;
    /** Opens the panel on a tab, or shuts it when that tab is the one it shows: what a click on the tab's item and the tab's key do. */
    toggleTab: (tab: SidePanelTab) => void;
}

/** The side panel of the selected project: whether it can be drawn, whether it is open and expanded, and how to flip it. */
export function useSidePanel(): SidePanelControl {
    const root = useRootStore();
    const ui =
        root.projectScreenReady && root.selectedProjectId ? root.ui.forProject(root.selectedProjectId) : undefined;

    return {
        available: ui !== undefined,
        railShown: root.phase === 'ready',
        open: ui?.sidePanelOpen === true,
        tab: ui?.sidePanelTab ?? 'files',
        expanded: ui?.sidePanelCoversChat === true,
        noHalf: ui?.sidePanelNoHalf ?? null,
        tabHasTree: ui?.sidePanelTabHasTree === true,
        toggle: () => ui?.toggleSidePanel(),
        setSize: size => ui?.setSidePanelSize(size),
        toggleTab: tab => ui?.toggleSidePanelTab(tab),
    };
}
