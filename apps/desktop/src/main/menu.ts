import { Menu, type MenuItem, type MenuItemConstructorOptions } from 'electron';

export interface AppMenuOptions {
    /** "Check for Updates…", in a build that updates itself. Gets the item, to disable it while a check runs. */
    checkForUpdates?: (item: MenuItem) => void;
}

/**
 * Electron's default menu without its Help entry (it links to Electron's own site), and with "Check for Updates…" in
 * the app menu (the File menu off macOS) when the build updates itself. Windows hides the menu bar behind the custom
 * title bar, so only the shortcuts matter there; it checks for updates on its own.
 */
export function createAppMenu({ checkForUpdates }: AppMenuOptions = {}): Menu {
    const mac = process.platform === 'darwin';
    const updates: MenuItemConstructorOptions[] = checkForUpdates ? [{ label: 'Check for Updates…', click: item => checkForUpdates(item) }] : [];
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
            : { role: 'fileMenu', submenu: [...updates, ...updates.length > 0 ? [{ type: 'separator' } as const] : [], { role: 'quit' }] },
        { role: 'editMenu' },
        {
            role: 'viewMenu',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
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
