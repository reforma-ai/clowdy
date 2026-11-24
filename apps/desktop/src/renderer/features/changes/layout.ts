/**
 * The least widths the Changes tab holds, as the file manager holds its own (`@clowdy/file-manager/layout`): the reading area, with the diffs, can be dragged no narrower than
 * 350px and the sidebar, with the files and commit box, no narrower than 150px. The side panel keeps its column at least as wide as both (`TREE_PANEL_MIN_WIDTH`), and puts the
 * tab in the chat's place where the window has no room for it beside the chat.
 */
export const CHANGES_READING_MIN_WIDTH = 350;
export const CHANGES_SIDEBAR_MIN_WIDTH = 150;

/** The width the sidebar opens at until the person drags the edge: in the 220 to 250 range the file lists and the branch rows are laid out for. */
export const CHANGES_SIDEBAR_DEFAULT_WIDTH = 240;

/** The narrowest the whole view can be: the reading area and the sidebar at their narrowest, side by side. */
export const CHANGES_MIN_WIDTH = CHANGES_READING_MIN_WIDTH + CHANGES_SIDEBAR_MIN_WIDTH;
