import type { SidePanelTab } from '../../stores';

/** The command that opens and shuts the side panel, by the id the hotkeys registry knows it by. */
export const SIDE_PANEL_COMMAND = 'sidePanel.toggle';

/** `Cmd+Esc` on macOS, `Ctrl+Shift+B` elsewhere: Windows keeps `Ctrl+Esc` for the Start menu, so the key never reaches the app there. */
export const SIDE_PANEL_KEYS = { mac: 'Meta+Escape', win: '$mod+Shift+b' } as const;

/** The command that opens the panel on a tab, or shuts the panel when that tab is already shown: it does what a click on the tab's item in the rail does. */
export const sidePanelTabCommand = (tab: SidePanelTab) => `sidePanel.tab.${ tab }`;

/** `Cmd+0`, `Cmd+1`, `Cmd+2` (`Ctrl+` off a Mac): the tabs, Files and Terminal on the digits that are easy to reach and Info on 0. A second press shuts the panel, as `Cmd+1` shuts the Project tool window of JetBrains, and a second click on the tab's item does the same. */
export const SIDE_PANEL_TAB_KEYS: Record<SidePanelTab, string> = { info: '$mod+0', files: '$mod+1', terminal: '$mod+2' };

/** The tabs' names, on the rail, the tooltips and the shortcuts page. */
export const SIDE_PANEL_TAB_LABELS: Record<SidePanelTab, string> = { info: 'Info', files: 'Files', terminal: 'Terminal' };

/** The command that opens the panel on its Terminal tab, or shuts the panel when that tab is already there. */
export const TERMINAL_COMMAND = 'sidePanel.terminal';

/** `Ctrl+`` on every system, as VS Code has it: the Control key even on a Mac, where Cmd+` is the system's own switch between windows. */
export const TERMINAL_KEYS = 'Control+Backquote';
