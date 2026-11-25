import { BrowserWindow, Menu, type MenuItem, type MenuItemConstructorOptions } from 'electron';

import { type FindCommand, IPC_CHANNELS } from '../shared/bridge';

export interface AppMenuOptions {
    /** "Check for Updates…", in a build that updates itself. Gets the item, to disable it while a check runs. */
    checkForUpdates?: (item: MenuItem) => void;
}

/** Find, Find Next or Find Previous, for the window that has the keyboard, else the one window there is. */
function sendFind(command: FindCommand): void {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];

    window?.webContents.send(IPC_CHANNELS.findCommand, command);
}

/** Find sits with the edit commands. The shortcuts are the window's: Chromium searches the text it has drawn. */
function findItems(): MenuItemConstructorOptions[] {
    return [
        { type: 'separator' },
        { id: 'find', label: 'Find', accelerator: 'CmdOrCtrl+F', click: () => sendFind('open') },
        { id: 'find-next', label: 'Find Next', accelerator: 'CmdOrCtrl+G', click: () => sendFind('next') },
        {
            id: 'find-previous',
            label: 'Find Previous',
            accelerator: 'CmdOrCtrl+Shift+G',
            click: () => sendFind('previous'),
        },
    ];
}

/**
 * Electron's default menu without its Help entry (it links to Electron's own site), and with "Check for Updates…" in
 * the app menu (the File menu off macOS) when the build updates itself. Windows hides the menu bar behind the custom
 * title bar, so only the shortcuts matter there; it checks for updates on its own. Find is in the Edit menu on both.
 */
export function createAppMenu({ checkForUpdates }: AppMenuOptions = {}): Menu {
    const mac = process.platform === 'darwin';
    const updates: MenuItemConstructorOptions[] = checkForUpdates
        ? [{ label: 'Check for Updates…', click: item => checkForUpdates(item) }]
        : [];
    const speech: MenuItemConstructorOptions = {
        label: 'Speech',
        submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }],
    };
    const editSubmenu: MenuItemConstructorOptions[] = [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(mac
            ? [
                  { role: 'pasteAndMatchStyle' } as const,
                  { role: 'delete' } as const,
                  { role: 'selectAll' } as const,
                  ...findItems(),
                  { type: 'separator' } as const,
                  speech,
              ]
            : [
                  { role: 'delete' } as const,
                  { type: 'separator' } as const,
                  { role: 'selectAll' } as const,
                  ...findItems(),
              ]),
    ];
    const template: MenuItemConstructorOptions[] = [
        mac
            ? {
                  role: 'appMenu',
                  submenu: [
                      { role: 'about' },
                      ...updates,
                      { type: 'separator' },
                      { role: 'services' },
                      { type: 'separator' },
                      { role: 'hide' },
                      { role: 'hideOthers' },
                      { role: 'unhide' },
                      { type: 'separator' },
                      { role: 'quit' },
                  ],
              }
            : {
                  role: 'fileMenu',
                  submenu: [
                      ...updates,
                      ...(updates.length > 0 ? [{ type: 'separator' } as const] : []),
                      { role: 'quit' },
                  ],
              },
        { label: 'Edit', submenu: editSubmenu },
        {
            role: 'viewMenu',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                // Cmd+0 (Ctrl+0) as in a browser: Cmd+Option+0 (Ctrl+Alt+0) is the personal space's key (`projectSwitch`), and a menu key reaches the page first.
                { role: 'resetZoom', accelerator: 'CmdOrCtrl+0' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' },
            ],
        },
        { role: 'windowMenu' },
    ];

    return Menu.buildFromTemplate(template);
}
