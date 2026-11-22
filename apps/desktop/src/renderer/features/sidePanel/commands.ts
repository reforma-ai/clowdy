/** The command that opens and shuts the side panel, by the id the hotkeys registry and the toggle button's tooltip know it by. */
export const SIDE_PANEL_COMMAND = 'sidePanel.toggle';

/** `Cmd+Shift+B` on macOS, `Ctrl+Shift+B` elsewhere, as Codex has it. */
export const SIDE_PANEL_KEYS = '$mod+Shift+b';

/** The command that opens the panel on its Terminal tab, or shuts the panel when that tab is already there. */
export const TERMINAL_COMMAND = 'sidePanel.terminal';

/** `Ctrl+`` on every system, as VS Code has it: the Control key even on a Mac, where Cmd+` is the system's own switch between windows. */
export const TERMINAL_KEYS = 'Control+Backquote';
