// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installDispatcher } from './dispatcher';
import { useCommands, useHotkeyScope, type ScopedCommand } from './react';
import { createRegistry, hotkeys, type HotkeyRegistry } from './registry';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let registry: HotkeyRegistry;
let uninstall: () => void;

function Probe({ scope, commands }: { scope: string; commands: ScopedCommand[] }) {
    useHotkeyScope(scope, registry);
    useCommands(scope, commands, registry);

    return null;
}

const render = (scope: string, commands: ScopedCommand[]) => act(() => root.render(<Probe scope={ scope } commands={ commands } />));
const press = (key: string) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

beforeEach(() => {
    registry = createRegistry('darwin');
    uninstall = installDispatcher(registry);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    uninstall();
    container.remove();
});

describe('useCommands and useHotkeyScope', () => {
    it('defines the commands and pushes the scope while mounted, and removes both on unmount', () => {
        const handler = vi.fn();

        render('tasks', [{ id: 'tasks.x', title: 'X', group: 'Tasks', keys: 'x', handler }]);

        expect(registry.scopes).toEqual(['tasks']);
        expect(registry.listCommands().live.map(({ id }) => id)).toEqual(['tasks.x']);

        press('x');

        expect(handler).toHaveBeenCalledTimes(1);

        act(() => root.render(null));

        expect(registry.scopes).toEqual([]);
        expect(registry.listCommands().all).toEqual([]);
    });

    it('runs the latest handler without registering again', () => {
        const define = vi.spyOn(registry, 'defineCommand');
        const first = vi.fn();
        const second = vi.fn();

        render('tasks', [{ id: 'tasks.x', title: 'X', group: 'Tasks', keys: 'x', handler: first }]);
        render('tasks', [{ id: 'tasks.x', title: 'X', group: 'Tasks', keys: 'x', handler: second }]);
        press('x');

        expect(define).toHaveBeenCalledTimes(1);
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
    });

    it('reads the latest when', () => {
        const handler = vi.fn();
        let enabled = false;

        render('tasks', [{ id: 'tasks.x', title: 'X', group: 'Tasks', keys: 'x', when: () => enabled, handler }]);
        press('x');

        expect(handler).not.toHaveBeenCalled();

        enabled = true;
        press('x');

        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('lets a scope that mounts later win over the one already mounted, and gives the key back when it leaves', () => {
        const tasks = vi.fn();
        const picker = vi.fn();
        const tasksCommands = [{ id: 'tasks.enter', title: 'Open', group: 'Tasks', keys: 'Enter', handler: tasks }];
        const pickerCommands = [{ id: 'picker.enter', title: 'Pick', group: 'Picker', keys: 'Enter', handler: picker }];
        const renderScreen = (pickerOpen: boolean) => act(() => root.render(
            <>
                <Probe scope="tasks" commands={ tasksCommands } />
                { pickerOpen && <Probe scope="picker" commands={ pickerCommands } /> }
            </>
        ));

        renderScreen(false);
        press('Enter');
        renderScreen(true);
        press('Enter');

        expect(tasks).toHaveBeenCalledTimes(1);
        expect(picker).toHaveBeenCalledTimes(1);

        renderScreen(false);
        press('Enter');

        expect(tasks).toHaveBeenCalledTimes(2);
        expect(picker).toHaveBeenCalledTimes(1);
    });

    it('registers again when keys or the set of commands change', () => {
        const define = vi.spyOn(registry, 'defineCommand');
        const handler = vi.fn();

        render('tasks', [{ id: 'tasks.x', title: 'X', group: 'Tasks', keys: 'x', handler }]);
        render('tasks', [{ id: 'tasks.x', title: 'X', group: 'Tasks', keys: 'y', handler }, { id: 'tasks.z', title: 'Z', group: 'Tasks', keys: 'z', handler }]);

        expect(define).toHaveBeenCalledTimes(3);
        expect(registry.listCommands().all.map(({ id }) => id)).toEqual(['tasks.x', 'tasks.z']);

        press('x');
        press('y');

        expect(handler).toHaveBeenCalledTimes(1);
    });
});

describe('the app registry', () => {
    function Standalone() {
        useHotkeyScope('modal');
        useCommands('modal', [{ id: 'modal.singleton-check', title: 'Close', group: 'Modal', keys: 'x', handler: () => undefined }]);

        return null;
    }

    it('takes commands from another React root with no registry passed, as a Modal.create root has no context', () => {
        const host = document.createElement('div');
        const modalRoot = createRoot(host);

        document.body.append(host);
        act(() => modalRoot.render(<Standalone />));

        expect(hotkeys.scopes).toEqual(['modal']);
        expect(hotkeys.listCommands().live.map(({ id }) => id)).toEqual(['modal.singleton-check']);

        act(() => modalRoot.unmount());
        host.remove();

        expect(hotkeys.scopes).toEqual([]);
        expect(hotkeys.listCommands().all).toEqual([]);
    });
});
