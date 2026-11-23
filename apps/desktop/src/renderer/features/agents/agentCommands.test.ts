// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installDispatcher } from '../../hotkeys/dispatcher';
import { createRegistry } from '../../hotkeys/registry';
import { AGENTS_SCOPE, agentCommands } from './agentCommands';

import type { HotkeyRegistry } from '../../hotkeys/registry';

let registry: HotkeyRegistry;
let uninstall: () => void;

/** The grid list's markup as React Aria draws it (rows keyed by `data-key`, a `⋯` button and a rename field inside), beside the composer. */
function mount() {
    document.body.innerHTML = `
        <nav><button id="rail">Agents</button></nav>
        <aside>
            <button id="new">New chat</button>
            <div id="list">
                <div role="grid" aria-label="Agents">
                    <div role="row" id="c1" data-key="c1" tabindex="0"><div role="gridcell"><span>Plan</span><button id="more1" tabindex="-1">More</button></div></div>
                    <div role="row" id="c2" data-key="c2" tabindex="-1"><div role="gridcell"><input id="rename" value="Fix"></div></div>
                    <div role="row" id="c3" data-key="c3" tabindex="-1"><div role="gridcell"><span>Docs</span></div></div>
                </div>
            </div>
        </aside>
        <section><textarea id="composer"></textarea></section>`;
}

const element = (id: string) => document.getElementById(id)!;
const focused = () => document.activeElement?.id ?? '';

function setup(openId: string | undefined = 'c1') {
    mount();
    registry = createRegistry('darwin');
    registry.pushScope(AGENTS_SCOPE);

    for (const command of agentCommands({
        list: () => element('list'),
        ids: () => ['c1', 'c2', 'c3'],
        openId: () => openId,
    }))
        registry.defineCommand(command);

    uninstall = installDispatcher(registry);
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

describe('agent commands', () => {
    it('register J and K in the Agents group for the agents scope', () => {
        setup();

        expect(
            registry.listCommands().all.map(({ id, title, group, keys, scope }) => [id, title, group, keys, scope])
        ).toEqual([
            ['agents.cursor.down', 'Move down', 'Agents', 'j', AGENTS_SCOPE],
            ['agents.cursor.up', 'Move up', 'Agents', 'k', AGENTS_SCOPE],
        ]);
    });

    it('move the focus from row to row, a chat or a run below it, by the row of the grid list', () => {
        setup();
        element('c1').focus();

        expect(press('j', element('c1'))).toBe(true);
        expect(focused()).toBe('c2');

        press('j', element('c2'));
        press('j', element('c3'));

        expect(focused()).toBe('c3');

        press('k', element('c3'));
        press('k', element('c2'));
        press('k', element('c1'));

        expect(focused()).toBe('c1');
    });

    it('first show the open chat when nothing has the focus, and on the rail', () => {
        setup('c2');

        press('j');

        expect(focused()).toBe('c2');

        element('rail').focus();
        press('k', element('rail'));

        expect(focused()).toBe('c2');
    });

    it("never take a key from the composer, the rename field, a row's button or the header button", () => {
        setup();

        for (const id of ['composer', 'rename', 'more1', 'new']) {
            element(id).focus();

            expect(press('j', element(id))).toBe(false);
            expect(press('k', element(id))).toBe(false);
            expect(focused()).toBe(id);
        }
    });

    it('stay live for the key hints while a field has the focus', () => {
        setup();
        element('composer').focus();

        expect(press('j', element('composer'))).toBe(false);
        expect(registry.listCommands().live.map(({ id }) => id)).toEqual(['agents.cursor.down', 'agents.cursor.up']);
    });
});
