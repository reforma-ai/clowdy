import { afterEach, describe, expect, it } from 'vitest';

import { commandPresses } from '../../hotkeys';
import { shortcutEntries } from '../../shell/keymap';
import { sidePanelTabKeys } from './commands';
import { PanelOrder, panelOrder } from './panelOrder';

const memory = (initial: string | null = null) => {
    let data = initial;
    return {
        getItem: () => data,
        setItem: (_key: string, value: string) => {
            data = value;
        },
    };
};

afterEach(() => panelOrder.reset());

describe('panel order', () => {
    it('uses rail order by default and repairs old, incomplete and duplicate entries', () => {
        expect(new PanelOrder().order).toEqual(['files', 'changes', 'docs', 'terminal', 'tasks']);
        expect(new PanelOrder(memory('["tasks","info","tasks","files"]')).order).toEqual([
            'tasks',
            'files',
            'changes',
            'docs',
            'terminal',
        ]);
        expect(new PanelOrder(memory('not json')).order).toEqual(['files', 'changes', 'docs', 'terminal', 'tasks']);
    });
    it('persists the order and resets it', () => {
        const storage = memory();
        const order = new PanelOrder(storage);
        order.setOrder(['tasks', 'files', 'changes', 'docs', 'terminal']);
        expect(new PanelOrder(storage).order).toEqual(order.order);
        order.reset();
        expect(new PanelOrder(storage).order[0]).toBe('files');
    });
    it('uses the current position for both commands and the shortcuts page on each platform', () => {
        panelOrder.setOrder(['tasks', 'files', 'changes', 'terminal', 'docs']);
        expect(commandPresses({ keys: sidePanelTabKeys('tasks') }, 'darwin')).toEqual([['meta', '1']]);
        expect(commandPresses({ keys: sidePanelTabKeys('docs') }, 'win32')).toEqual([['ctrl', '5']]);
        const task = shortcutEntries('darwin').find(entry => entry.command.id === 'sidePanel.tab.tasks')!;
        expect(task.sequences).toEqual([[['meta', '1']]]);
    });
});
