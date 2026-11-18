// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installDispatcher } from '../../hotkeys/dispatcher';
import { createRegistry } from '../../hotkeys/registry';
import { AGENTS_SCOPE, focusRun, runCommands } from './runCommands';

import type { HotkeyRegistry } from '../../hotkeys/registry';

let registry: HotkeyRegistry;
let uninstall: () => void;

/** The run tree as `RunRow` draws it: a `treeitem` per run, a chevron button and a task chip inside, the search field above. */
function mount() {
    document.body.innerHTML = `
        <nav><button id="rail">Agents</button></nav>
        <aside>
            <input id="search">
            <div id="tree" role="tree" aria-label="Agents">
                <div role="treeitem" id="r1" data-run-id="r1" tabindex="0"><button id="chevron" tabindex="-1">Collapse</button></div>
                <div role="treeitem" id="r2" data-run-id="r2" tabindex="-1"><a id="chip" href="#task">CAR-1</a></div>
                <div role="treeitem" id="r3" data-run-id="r3" tabindex="-1"></div>
            </div>
        </aside>
        <section><div id="stream" tabindex="0"></div></section>`;
}

const element = (id: string) => document.getElementById(id)!;
const focused = () => document.activeElement?.id ?? '';

function setup(openId: string | null = 'r1') {
    mount();
    registry = createRegistry('darwin');

    const select = vi.fn<(runId: string) => void>();

    registry.pushScope(AGENTS_SCOPE);

    for (const command of runCommands({ tree: () => element('tree'), ids: () => ['r1', 'r2', 'r3'], openId: () => openId, select })) registry.defineCommand(command);

    uninstall = installDispatcher(registry);

    return { select };
}

/** Whether a command took the key. */
function press(key: string, target: Element = document.body): boolean {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });

    target.dispatchEvent(event);

    return event.defaultPrevented;
}

beforeEach(() => {
    document.body.innerHTML = '';
});

afterEach(() => {
    uninstall?.();
});

describe('run tree commands', () => {
    it('register J and K in the Agents group for the agents scope', () => {
        setup();

        expect(registry.listCommands().all.map(({ id, title, group, keys, scope }) => [id, title, group, keys, scope])).toEqual([
            ['agents.cursor.down', 'Move down', 'Agents', 'j', AGENTS_SCOPE],
            ['agents.cursor.up', 'Move up', 'Agents', 'k', AGENTS_SCOPE],
        ]);
    });

    it('move the focus to the next and the previous run and select it, as the arrows do', () => {
        const { select } = setup();

        element('r1').focus();
        press('j', element('r1'));

        expect(focused()).toBe('r2');
        expect(select).toHaveBeenLastCalledWith('r2');

        press('j', element('r2'));
        press('k', element('r3'));
        press('k', element('r2'));
        press('k', element('r1'));

        expect(focused()).toBe('r1');
        expect(select.mock.calls.map(([runId]) => runId)).toEqual(['r2', 'r3', 'r2', 'r1']);
    });

    it('focus a run by the id on its row, which is also what the arrows use', () => {
        setup();
        focusRun(element('tree'), 'r3');

        expect(focused()).toBe('r3');

        focusRun(null, 'r1');
        focusRun(element('tree'), 'missing');

        expect(focused()).toBe('r3');
    });

    it('show the selected run first, without selecting anything, while nothing has the focus', () => {
        const { select } = setup('r2');

        press('j');

        expect(focused()).toBe('r2');
        expect(select).not.toHaveBeenCalled();
    });

    it('leave the search field, the chevron, a task chip and the run\'s stream to their own keys', () => {
        const { select } = setup();

        for (const id of ['search', 'chevron', 'chip', 'stream']) {
            element(id).focus();

            expect(press('j', element(id))).toBe(false);
            expect(press('k', element(id))).toBe(false);
            expect(focused()).toBe(id);
        }

        expect(select).not.toHaveBeenCalled();
    });
});
