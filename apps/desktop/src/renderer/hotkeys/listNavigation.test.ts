// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installDispatcher } from './dispatcher';
import { listFocusOf, listMoveCommands } from './listNavigation';
import { commandHint } from './react';
import { createRegistry } from './registry';

import type { HotkeyRegistry } from './registry';

const itemId = (element: Element) => (element as HTMLElement).dataset.id ?? null;

/** A list of three focusable items with a control inside the first, an input beside it, a rail, a page of its own, and a side panel with a breadcrumb. */
function mount() {
    document.body.innerHTML = `
        <nav><button id="rail">Chats</button></nav>
        <main id="screen">
            <nav><button id="crumb">Docs</button></nav>
            <input id="search">
            <div id="region">
                <div id="a" data-id="a" tabindex="-1"><button id="more">More</button></div>
                <div id="b" data-id="b" tabindex="-1"></div>
                <div id="c" data-id="c" tabindex="-1"></div>
            </div>
            <textarea id="composer"></textarea>
        </main>
        <aside><nav><button id="panelCrumb">Tasks</button></nav></aside>`;

    return { region: document.getElementById('region')!, element: (id: string) => document.getElementById(id)! };
}

let registry: HotkeyRegistry;
let uninstall: () => void;

function setup({ ids = ['a', 'b', 'c'], openId = null as string | null, scope = true } = {}) {
    const { region, element } = mount();
    const follow = vi.fn<(id: string) => void>();
    const state = { ids, openId };

    registry = createRegistry('darwin');

    if (scope) registry.pushScope('list');

    for (const command of listMoveCommands({
        scope: 'list',
        prefix: 'list',
        group: 'List',
        ids: () => state.ids,
        focus: () => listFocusOf(region, itemId),
        openId: () => state.openId,
        focusItem: id => element(id).focus(),
        follow,
    })) registry.defineCommand(command);

    uninstall = installDispatcher(registry);

    return { region, element, follow, state };
}

/** Whether a command took the key (the dispatcher calls `preventDefault`). */
function press(key: string, init: KeyboardEventInit = {}, target: Element = document.body): boolean {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });

    target.dispatchEvent(event);

    return event.defaultPrevented;
}

const focused = () => document.activeElement?.id ?? '';

beforeEach(() => {
    document.body.innerHTML = '';
});

afterEach(() => {
    uninstall?.();
});

describe('listFocusOf', () => {
    it('tells an item, nothing in particular, and anything else apart', () => {
        const { region, element } = mount();
        const zoneOn = (id: string) => {
            element(id).focus();

            return listFocusOf(region, itemId);
        };

        expect(listFocusOf(region, itemId)).toEqual({ zone: 'idle' });
        expect(zoneOn('b')).toEqual({ zone: 'item', id: 'b' });
        expect(zoneOn('more')).toEqual({ zone: 'other' });
        expect(zoneOn('search')).toEqual({ zone: 'other' });
        expect(zoneOn('composer')).toEqual({ zone: 'other' });
        expect(zoneOn('rail')).toEqual({ zone: 'idle' });
        // A breadcrumb is a `nav` too, but it belongs to the screen and keeps its keys, in the side panel as on the page.
        expect(zoneOn('crumb')).toEqual({ zone: 'other' });
        expect(zoneOn('panelCrumb')).toEqual({ zone: 'other' });
    });

    it('is idle or other without a region, by where the focus is', () => {
        const { element } = mount();

        expect(listFocusOf(null, itemId)).toEqual({ zone: 'idle' });

        element('composer').focus();

        expect(listFocusOf(null, itemId)).toEqual({ zone: 'other' });
    });
});

describe('J and K', () => {
    it('move the focus to the next and the previous item, and hold down to keep moving', () => {
        const { element } = setup();

        element('a').focus();

        expect(press('j', {}, element('a'))).toBe(true);
        expect(focused()).toBe('b');

        press('j', { repeat: true }, element('b'));

        expect(focused()).toBe('c');

        press('k', {}, element('c'));
        press('k', { repeat: true }, element('b'));

        expect(focused()).toBe('a');
    });

    it('stop at the ends and do not wrap, and the key stays ours', () => {
        const { element, follow } = setup();

        element('a').focus();

        expect(press('k', {}, element('a'))).toBe(true);
        expect(focused()).toBe('a');
        expect(follow).not.toHaveBeenCalled();

        element('c').focus();
        press('j', {}, element('c'));

        expect(focused()).toBe('c');
        expect(follow).not.toHaveBeenCalled();
    });

    it('tell a list whose focus opens its item which item they moved to', () => {
        const { element, follow } = setup();

        element('a').focus();
        press('j', {}, element('a'));
        press('j', {}, element('b'));
        press('k', {}, element('c'));

        expect(follow.mock.calls).toEqual([['b'], ['c'], ['b']]);
    });

    it('bring the focus in without moving it while nothing has the focus, to the open item', () => {
        const { state, follow } = setup({ openId: 'b' });

        expect(press('j')).toBe(true);
        expect(focused()).toBe('b');

        // The first key only shows where the list is; the next one moves.
        press('j', {}, document.activeElement!);

        expect(focused()).toBe('c');
        expect(follow.mock.calls).toEqual([['c']]);

        document.body.focus();
        (document.activeElement as HTMLElement).blur();
        state.openId = null;
        press('k');

        expect(focused()).toBe('a');
    });

    it('start at the first item when the open one is not in the list', () => {
        setup({ openId: 'gone' });

        press('j');

        expect(focused()).toBe('a');
    });

    it('bring the focus in from a button of the rail', () => {
        const { element } = setup({ openId: 'c' });

        element('rail').focus();

        expect(press('k', {}, element('rail'))).toBe(true);
        expect(focused()).toBe('c');
    });

    it('leave a control inside an item, a search field, a breadcrumb and the composer to their own keys', () => {
        const { element } = setup();

        for (const id of ['more', 'search', 'composer', 'crumb']) {
            element(id).focus();

            expect(press('j', {}, element(id))).toBe(false);
            expect(press('k', {}, element(id))).toBe(false);
            expect(focused()).toBe(id);
        }
    });

    it('stay off while a dialog is open, wherever the focus is', () => {
        const { element } = setup();
        const overlay = document.createElement('div');

        overlay.setAttribute('data-modal-overlay', '');
        document.body.append(overlay);
        element('a').focus();

        expect(press('j', {}, element('a'))).toBe(false);
        expect(press('j')).toBe(false);
        expect(focused()).toBe('a');
    });

    it('stay listed and keep their hint while the focus is in a field, though the key is its own there', () => {
        const { element } = setup();

        element('search').focus();

        expect(press('j', {}, element('search'))).toBe(false);
        expect(registry.listCommands().live.map(command => command.id)).toEqual(['list.cursor.down', 'list.cursor.up']);
        expect(commandHint('list.cursor.down', registry)).toEqual([['j']]);
    });

    it('are not live without items, so there is nothing to list or hint', () => {
        setup({ ids: [] });

        expect(registry.listCommands().live).toEqual([]);
        expect(commandHint('list.cursor.up', registry)).toBeUndefined();
    });

    it('do nothing and take no key without items, or when the scope is not on the stack', () => {
        setup({ ids: [] });

        expect(press('j')).toBe(false);
        uninstall();

        const off = setup({ scope: false });

        off.element('a').focus();

        expect(press('j', {}, off.element('a'))).toBe(false);
        expect(focused()).toBe('a');
    });

    it('are plain keys: a modifier makes them another key', () => {
        const { element } = setup();

        element('a').focus();

        expect(press('j', { metaKey: true }, element('a'))).toBe(false);
        expect(press('j', { ctrlKey: true }, element('a'))).toBe(false);
        expect(press('J', { shiftKey: true }, element('a'))).toBe(false);
        expect(focused()).toBe('a');
    });

    it('define one command per direction, named by the prefix, in the group', () => {
        setup();

        const commands = registry.listCommands().all;

        expect(commands.map(({ id, group, keys }) => [id, group, keys])).toEqual([
            ['list.cursor.down', 'List', 'j'],
            ['list.cursor.up', 'List', 'k'],
        ]);
    });
});
