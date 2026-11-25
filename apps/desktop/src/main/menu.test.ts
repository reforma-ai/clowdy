import { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { IPC_CHANNELS } from '../shared/bridge';
import { createAppMenu } from './menu';

const { send, getFocusedWindow, getAllWindows } = vi.hoisted(() => ({
    send: vi.fn(),
    getFocusedWindow: vi.fn(),
    getAllWindows: vi.fn(),
}));

vi.mock('electron', () => ({
    Menu: { buildFromTemplate: (template: unknown) => template },
    BrowserWindow: { getFocusedWindow, getAllWindows },
}));

interface Item {
    id?: string;
    label?: string;
    accelerator?: string;
    role?: string;
    click?: () => void;
    submenu?: Item[];
}

const items = () => createAppMenu() as unknown as Item[];

function findItem(id: string, list: Item[] = items()): Item | undefined {
    for (const item of list) {
        if (item.id === id) return item;

        const nested = item.submenu && findItem(id, item.submenu);

        if (nested) return nested;
    }

    return undefined;
}

describe('the View menu', () => {
    test('resets the zoom on Cmd+0, which leaves Cmd+Option+0 to the personal space', () => {
        const view = items().find(item => item.role === 'viewMenu')?.submenu ?? [];

        expect(view.find(item => item.role === 'resetZoom')?.accelerator).toBe('CmdOrCtrl+0');
        expect(view.some(item => item.accelerator === 'CmdOrCtrl+Alt+0')).toBe(false);
    });
});

describe('Find in the Edit menu', () => {
    beforeEach(() => {
        send.mockReset();
        getFocusedWindow.mockReset();
        getAllWindows.mockReset();
    });

    test('has Find, Find Next and Find Previous on the usual shortcuts', () => {
        expect(findItem('find')).toMatchObject({ label: 'Find', accelerator: 'CmdOrCtrl+F' });
        expect(findItem('find-next')).toMatchObject({ label: 'Find Next', accelerator: 'CmdOrCtrl+G' });
        expect(findItem('find-previous')).toMatchObject({ label: 'Find Previous', accelerator: 'CmdOrCtrl+Shift+G' });
        expect(items().some(item => item.role === 'editMenu')).toBe(false);
    });

    test('tells the focused window, or the only window, to find', () => {
        const focused = { webContents: { send } };
        const other = { webContents: { send: vi.fn() } };

        getFocusedWindow.mockReturnValue(focused);

        findItem('find')!.click!();

        expect(send).toHaveBeenCalledWith(IPC_CHANNELS.findCommand, 'open');

        getFocusedWindow.mockReturnValue(null);
        getAllWindows.mockReturnValue([other]);

        findItem('find-next')!.click!();
        findItem('find-previous')!.click!();

        expect(other.webContents.send).toHaveBeenNthCalledWith(1, IPC_CHANNELS.findCommand, 'next');
        expect(other.webContents.send).toHaveBeenNthCalledWith(2, IPC_CHANNELS.findCommand, 'previous');
        expect(BrowserWindow.getAllWindows).toHaveBeenCalled();
    });
});
