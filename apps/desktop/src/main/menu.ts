import { Menu, type MenuItemConstructorOptions } from 'electron';

/**
 * Electron's default menu without its Help entry (it links to Electron's own site).
 * Windows hides the menu bar behind the custom title bar, so only the shortcuts matter there.
 */
export function createAppMenu(): Menu {
    const mac = process.platform === 'darwin';
    const template: MenuItemConstructorOptions[] = [
        ...mac ? [{ role: 'appMenu' } satisfies MenuItemConstructorOptions] : [{ role: 'fileMenu' } satisfies MenuItemConstructorOptions],
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
