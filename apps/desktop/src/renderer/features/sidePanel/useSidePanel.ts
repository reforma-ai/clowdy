import { useRootStore } from '../../stores';

export interface SidePanelControl {
    /** The window shows a project's screen, so the panel and its button can be there. */
    available: boolean;
    /** The panel is drawn: it is open for the selected project, and the window can show it. */
    open: boolean;
    toggle: () => void;
}

/** The side panel of the selected project: whether it can be drawn, whether it is open, and how to flip it. */
export function useSidePanel(): SidePanelControl {
    const root = useRootStore();
    const ui = root.showsProjectScreen && root.selectedProjectId ? root.ui.forProject(root.selectedProjectId) : undefined;

    return { available: ui !== undefined, open: ui?.sidePanelOpen === true, toggle: () => ui?.toggleSidePanel() };
}
