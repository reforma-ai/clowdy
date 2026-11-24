import { SIDEBAR_MIN_WIDTH } from '@clowdy/components/Resizable';

/** The minimum widths of the diff and Source Control columns. */
export const CHANGES_READING_MIN_WIDTH = 350;
export const CHANGES_SIDEBAR_MIN_WIDTH = SIDEBAR_MIN_WIDTH;

/** The width the sidebar opens at until the person drags the edge: in the 220 to 250 range the file lists and the branch rows are laid out for. */
export const CHANGES_SIDEBAR_DEFAULT_WIDTH = 240;

/** The narrowest the whole view can be: the reading area and the sidebar at their narrowest, side by side. */
export const CHANGES_MIN_WIDTH = CHANGES_READING_MIN_WIDTH + CHANGES_SIDEBAR_MIN_WIDTH;
