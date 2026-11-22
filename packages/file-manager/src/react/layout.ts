/** The narrowest the sidebar (the file tree) and the editor can be dragged to. */
export const SIDEBAR_MIN_WIDTH = 150;
export const EDITOR_MIN_WIDTH = 350;

/** The narrowest the view can be: its editor and its sidebar at their narrowest, side by side. The host's column for the view has to hold it. */
export const FILE_MANAGER_MIN_WIDTH = SIDEBAR_MIN_WIDTH + EDITOR_MIN_WIDTH;
