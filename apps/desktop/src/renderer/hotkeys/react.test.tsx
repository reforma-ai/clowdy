// @vitest-environment happy-dom
import { observable, runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandHotkey } from './CommandHotkey';
import { installDispatcher } from './dispatcher';
import { commandHint, commandTooltip, type ScopedCommand, useCommands, useHotkeyScope } from './react';
import { createRegistry, type HotkeyRegistry, hotkeys } from './registry';

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

const render = (scope: string, commands: ScopedCommand[]) =>
    act(() => root.render(<Probe scope={scope} commands={commands} />));
const press = (key: string) =>
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

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

    it('reads the latest focus', () => {
        const handler = vi.fn();
        let inList = false;

        render('tasks', [{ id: 'tasks.x', title: 'X', group: 'Tasks', keys: 'x', focus: () => inList, handler }]);
        press('x');

        expect(handler).not.toHaveBeenCalled();
        expect(registry.listCommands().live.map(({ id }) => id)).toEqual(['tasks.x']);

        inList = true;
        press('x');

        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('lets a scope that mounts later win over the one already mounted, and gives the key back when it leaves', () => {
        const tasks = vi.fn();
        const picker = vi.fn();
        const tasksCommands = [{ id: 'tasks.enter', title: 'Open', group: 'Tasks', keys: 'Enter', handler: tasks }];
        const pickerCommands = [{ id: 'picker.enter', title: 'Pick', group: 'Picker', keys: 'Enter', handler: picker }];
        const renderScreen = (pickerOpen: boolean) =>
            act(() =>
                root.render(
                    <>
                        <Probe scope="tasks" commands={tasksCommands} />
                        {pickerOpen && <Probe scope="picker" commands={pickerCommands} />}
                    </>
                )
            );

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
        render('tasks', [
            { id: 'tasks.x', title: 'X', group: 'Tasks', keys: 'y', handler },
            { id: 'tasks.z', title: 'Z', group: 'Tasks', keys: 'z', handler },
        ]);

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
        useCommands('modal', [
            { id: 'modal.singleton-check', title: 'Close', group: 'Modal', keys: 'x', handler: () => undefined },
        ]);

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

/**
 * The app's components are observers through the babel plugin, which Vitest does not run: `observer` stands in for it here.
 * What matters is that `commandHint` reads the registry's observables while a component renders.
 */
describe('commandHint', () => {
    const hint = (id: string) => commandHint(id, registry);
    const define = (command: Partial<ScopedCommand> & { scope?: string } = {}) =>
        registry.defineCommand({
            id: 'nav.tasks',
            title: 'Go to Tasks',
            group: 'Navigation',
            keys: 'g t',
            scope: 'app',
            handler: () => undefined,
            ...command,
        });

    const Hint = observer(({ id }: { id: string }) => <span data-hint>{JSON.stringify(hint(id) ?? null)}</span>);
    const shown = () => container.querySelector('[data-hint]')?.textContent;
    const renderHint = (id = 'nav.tasks') => act(() => root.render(<Hint id={id} />));

    it('gives the first keys of a command that can run, as presses of key names', () => {
        define();
        define({ id: 'help.open', keys: ['?', '$mod+/'], title: 'Help' });

        expect(hint('nav.tasks')).toEqual([['g'], ['t']]);
        expect(hint('help.open')).toEqual([['?']]);
    });

    it("gives the keys of the registry's platform", () => {
        const windows = createRegistry('win32');

        windows.defineCommand({
            id: 'help.open',
            title: 'Help',
            group: 'General',
            keys: '$mod+/',
            scope: 'app',
            handler: () => undefined,
        });
        define({ id: 'help.open', keys: '$mod+/', title: 'Help' });

        expect(commandHint('help.open', windows)).toEqual([['ctrl', '/']]);
        expect(hint('help.open')).toEqual([['meta', '/']]);
    });

    it('gives nothing for an unknown command', () => {
        expect(hint('nav.nowhere')).toBeUndefined();
    });

    it('gives nothing while the scope of the command is not on the stack, and again when it is', () => {
        define({ scope: 'tasks' });

        expect(hint('nav.tasks')).toBeUndefined();

        const leave = registry.pushScope('tasks');

        expect(hint('nav.tasks')).toEqual([['g'], ['t']]);

        leave();

        expect(hint('nav.tasks')).toBeUndefined();
    });

    it('gives nothing while the when of the command says no', () => {
        let enabled = false;

        define({ when: () => enabled });

        expect(hint('nav.tasks')).toBeUndefined();

        enabled = true;

        expect(hint('nav.tasks')).toEqual([['g'], ['t']]);
    });

    it('still gives the keys while the focus is not where the command applies, because the focus is not part of the answer', () => {
        define({ focus: () => false });

        expect(hint('nav.tasks')).toEqual([['g'], ['t']]);
        expect(commandTooltip('Go to Tasks', 'nav.tasks', registry)).not.toBeUndefined();
    });

    it('makes a component render again when the observable a when reads changes', () => {
        const state = observable({ project: null as string | null });

        define({ when: () => state.project !== null });
        renderHint();

        expect(shown()).toBe('null');

        act(() =>
            runInAction(() => {
                state.project = 'p';
            })
        );

        expect(shown()).toBe('[["g"],["t"]]');

        act(() =>
            runInAction(() => {
                state.project = null;
            })
        );

        expect(shown()).toBe('null');
    });

    it('makes a component render again when its scope comes and goes', () => {
        define({ scope: 'tasks' });
        renderHint();

        expect(shown()).toBe('null');

        let leave: () => void = () => undefined;

        act(() => {
            leave = registry.pushScope('tasks');
        });

        expect(shown()).toBe('[["g"],["t"]]');

        act(() => leave());

        expect(shown()).toBe('null');
    });

    it('makes a component render again when the command is defined and removed', () => {
        renderHint();

        expect(shown()).toBe('null');

        let remove: () => void = () => undefined;

        act(() => {
            remove = define();
        });

        expect(shown()).toBe('[["g"],["t"]]');

        act(() => remove());

        expect(shown()).toBe('null');
    });

    describe('CommandHotkey', () => {
        const Keyed = observer(CommandHotkey);
        const capsules = () => Array.from(container.querySelectorAll('[data-hotkey]'), element => element.textContent);

        it('draws a capsule per press of a sequence, and nothing while the command cannot run', () => {
            const state = observable({ project: null as string | null });

            define({ when: () => state.project !== null });
            act(() => root.render(<Keyed id="nav.tasks" registry={registry} />));

            expect(container.innerHTML).toBe('');

            act(() =>
                runInAction(() => {
                    state.project = 'p';
                })
            );

            expect(capsules()).toEqual(['G', 'T']);
            expect(container.textContent).toBe('GthenT');
        });

        it('draws one capsule for one press', () => {
            define({ id: 'tasks.escape', keys: 'Escape' });
            act(() => root.render(<Keyed id="tasks.escape" registry={registry} />));

            expect(capsules()).toEqual(['Esc']);
            expect(container.querySelector('[data-hotkey-sequence]')).toBeNull();
        });
    });

    describe('commandTooltip', () => {
        it('is undefined without a hint, so the control gets no tooltip', () => {
            expect(commandTooltip('Tasks', 'nav.tasks', registry)).toBeUndefined();

            define({ scope: 'tasks' });

            expect(commandTooltip('Tasks', 'nav.tasks', registry)).toBeUndefined();
        });

        it('is the label and the keys once the command can run', () => {
            define();
            act(() => root.render(<div>{commandTooltip('Tasks', 'nav.tasks', registry)}</div>));

            expect(container.textContent).toBe('Tasks GthenT');
        });
    });
});
