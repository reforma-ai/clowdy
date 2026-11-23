/**
 * The least widths the Changes tab holds, as the file manager holds its own (`@clowdy/file-manager/layout`): the reading area, with the diffs, can be dragged no narrower than
 * 350px and the sidebar, with the files and commits, no narrower than 150px. The side panel keeps its column at least as wide as both (`TREE_PANEL_MIN_WIDTH`), and puts the
 * tab in the chat's place where the window has no room for it beside the chat.
 */
export const CHANGES_READING_MIN_WIDTH = 350;
export const CHANGES_SIDEBAR_MIN_WIDTH = 150;

/** The width the sidebar opens at until the person drags the edge: in the 220 to 250 range the file lists and the branch rows are laid out for. */
export const CHANGES_SIDEBAR_DEFAULT_WIDTH = 240;

/** The narrowest the whole view can be: the reading area and the sidebar at their narrowest, side by side. */
export const CHANGES_MIN_WIDTH = CHANGES_READING_MIN_WIDTH + CHANGES_SIDEBAR_MIN_WIDTH;

/**
 * The commits of the branch at the foot of the sidebar, a list that is shut until it is opened and as tall as the person drags it. A row is the design system's two-line option
 * (`ListBoxItem` stacked: 8px above and below two 16px lines with 1px between), 2px apart, and the list stands 4px inside its box at the top and the bottom.
 */
export const CHANGES_COMMIT_ROW_HEIGHT = 49;
const COMMIT_ROWS_GAP = 2;
const COMMIT_LIST_PADDING = 8;

/** The height of the commits' box that shows `rows` rows whole. */
export const commitListHeight = (rows: number): number =>
    rows * CHANGES_COMMIT_ROW_HEIGHT + Math.max(0, rows - 1) * COMMIT_ROWS_GAP + COMMIT_LIST_PADDING;

/** The least the commits' box can be dragged to: two rows. */
export const CHANGES_COMMITS_MIN_HEIGHT = commitListHeight(2);

/** What the box opens at until the person drags it: five rows (fewer for a branch with fewer commits, two at the least), and never more than this share of its column. */
export const CHANGES_COMMITS_DEFAULT_ROWS = 5;
export const CHANGES_COMMITS_DEFAULT_SHARE = 0.4;

/** The least the changed files keep above the commit box and the commits, their title included, so the commits' box can never be dragged over them. */
export const CHANGES_FILES_MIN_HEIGHT = 96;
