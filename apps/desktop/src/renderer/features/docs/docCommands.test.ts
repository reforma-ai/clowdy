// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installDispatcher } from '../../hotkeys/dispatcher';
import { createRegistry } from '../../hotkeys/registry';
import { DOCS_SCOPE, docSaveCommand, docSearchCommand, docTreeCommands } from './docCommands';

import type { HotkeyRegistry, Platform } from '../../hotkeys/registry';

let registry: HotkeyRegistry;
let uninstall: () => void;

/** The tree as `DocsTree` draws it (a folder and files, the key of its folder and path on each row), beside the editor and the sidebar's search field. */
function mount() {
    document.body.innerHTML = `
        <nav><button id="rail">Docs</button></nav>
        <aside>
            <input id="search">
            <div id="tree" role="tree" aria-label="Documents">
                <div role="treeitem" id="folder" data-key="f1/notes" tabindex="0"></div>
                <div role="treeitem" id="a" data-key="f1/notes/a.md" tabindex="-1"></div>
                <div role="treeitem" id="b" data-key="f1/b.md" tabindex="-1"></div>
                <div role="treeitem" id="gone" data-key="f1/gone.md" tabindex="-1"></div>
            </div>
        </aside>
        <section>
            <div id="editor" contenteditable="true"></div>
            <textarea id="source"></textarea>
            <button id="save">Save</button>
        </section>`;
}

const element = (id: string) => document.getElementById(id)!;
const focused = () => document.activeElement?.id ?? '';
const KEYS = ['f1/notes', 'f1/notes/a.md', 'f1/b.md', 'f1/gone.md'];
const BY_ID: Record<string, string> = { folder: 'f1/notes', a: 'f1/notes/a.md', b: 'f1/b.md', gone: 'f1/gone.md' };

function setup(openId: string | null = 'f1/b.md') {
    mount();
    registry = createRegistry('darwin');
    registry.pushScope(DOCS_SCOPE);

    for (const command of docTreeCommands({ tree: () => element('tree'), ids: () => KEYS, openId: () => openId })) registry.defineCommand(command);

    uninstall = installDispatcher(registry);
}

/** Whether a command took the key. */
function press(key: string, target: Element = document.body, init: KeyboardEventInit = {}): boolean {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });

    target.dispatchEvent(event);

    return event.defaultPrevented;
}

beforeEach(() => {
    document.body.innerHTML = '';
});

afterEach(() => {
    uninstall?.();
});

describe('document tree commands', () => {
    it('register J and K in the Documents group for the docs scope', () => {
        setup();

        expect(registry.listCommands().all.map(({ id, title, group, keys, scope }) => [id, title, group, keys, scope])).toEqual([
            ['docs.cursor.down', 'Move down', 'Documents', 'j', DOCS_SCOPE],
            ['docs.cursor.up', 'Move up', 'Documents', 'k', DOCS_SCOPE],
        ]);
    });

    it('move the focus through folders, files and removed documents by the key on the row', () => {
        setup();
        element('folder').focus();

        for (const id of ['a', 'b', 'gone']) {
            press('j', document.activeElement!);

            expect(focused()).toBe(id);
        }

        press('j', element('gone'));

        expect(focused()).toBe('gone');

        for (const id of ['b', 'a', 'folder']) {
            press('k', document.activeElement!);

            expect(focused()).toBe(id);
        }
    });

    it('show the open document first while nothing has the focus', () => {
        setup('f1/notes/a.md');

        press('j');

        expect(focused()).toBe('a');
    });

    it('leave the search field, the editor, the Markdown source and the Save button to their own keys', () => {
        setup();

        for (const id of ['search', 'editor', 'source', 'save']) {
            element(id).focus();

            expect(press('j', element(id))).toBe(false);
            expect(press('k', element(id))).toBe(false);
            expect(focused()).toBe(id);
        }
    });

    it('stay live for the help overlay and the key hints while a field has the focus, as the overlay\'s own search field does', () => {
        setup();
        element('search').focus();

        expect(press('j', element('search'))).toBe(false);
        expect(registry.listCommands().live.map(({ id }) => id)).toEqual(['docs.cursor.down', 'docs.cursor.up']);
    });
});

describe('save', () => {
    interface FakeStore {
        current: { dirty: boolean; conflict: object | null } | undefined;
        save: ReturnType<typeof vi.fn>;
    }

    function setupSave(platform: Platform = 'darwin', buffer: FakeStore['current'] = { dirty: true, conflict: null }) {
        mount();
        registry = createRegistry(platform);
        registry.pushScope(DOCS_SCOPE);

        const store: FakeStore = { current: buffer, save: vi.fn() };

        registry.defineCommand(docSaveCommand(store as never));
        uninstall = installDispatcher(registry);

        return store;
    }

    const modifier = (platform: Platform): KeyboardEventInit => (platform === 'darwin' ? { metaKey: true } : { ctrlKey: true });

    it.each(['darwin', 'win32'] as const)('saves the open document on Mod+S from the editor, the source and the page (%s), and keeps the browser from saving the page', (platform) => {
        const store = setupSave(platform);

        expect(press('s', element('editor'), modifier(platform))).toBe(true);
        expect(press('s', element('source'), modifier(platform))).toBe(true);
        expect(press('S', document.body, modifier(platform))).toBe(true);
        expect(store.save).toHaveBeenCalledTimes(3);
    });

    it('is defined in the Documents group, for any text field, with the key a hint shows', () => {
        setupSave();

        const [save] = registry.listCommands().all;

        expect(save).toMatchObject({ id: 'docs.save', title: 'Save document', group: 'Documents', keys: '$mod+s', scope: DOCS_SCOPE, inInputs: true });
    });

    it('does nothing and takes no key when there is nothing to save', () => {
        const clean = setupSave('darwin', { dirty: false, conflict: null });

        expect(press('s', element('editor'), { metaKey: true })).toBe(false);
        expect(clean.save).not.toHaveBeenCalled();

        clean.current = { dirty: true, conflict: {} };

        expect(press('s', element('editor'), { metaKey: true })).toBe(false);

        clean.current = undefined;

        expect(press('s', element('editor'), { metaKey: true })).toBe(false);
        expect(clean.save).not.toHaveBeenCalled();
    });

    it('needs the platform\'s own modifier, and no other', () => {
        const store = setupSave('darwin');

        expect(press('s', element('editor'), { ctrlKey: true })).toBe(false);
        expect(press('s', element('editor'))).toBe(false);
        expect(press('s', element('editor'), { metaKey: true, shiftKey: true })).toBe(false);
        expect(store.save).not.toHaveBeenCalled();
    });

    it('does not save behind a dialog', () => {
        const store = setupSave();
        const overlay = document.createElement('div');

        overlay.setAttribute('data-modal-overlay', '');
        document.body.append(overlay);

        expect(press('s', element('editor'), { metaKey: true })).toBe(false);
        expect(store.save).not.toHaveBeenCalled();
    });
});

describe('find document', () => {
    function setupSearch() {
        mount();
        registry = createRegistry('darwin');
        registry.pushScope(DOCS_SCOPE);
        registry.defineCommand(docSearchCommand(() => {
            const field = element('search') as HTMLInputElement;

            field.focus();
            field.select();
        }));
        uninstall = installDispatcher(registry);
    }

    it('is / in the Documents group', () => {
        setupSearch();

        expect(registry.listCommands().all.map(({ id, title, group, keys, scope }) => [id, title, group, keys, scope])).toEqual([
            ['docs.search', 'Find document', 'Documents', '/', DOCS_SCOPE],
        ]);
    });

    it('puts the keyboard in the search field, and a slash typed there is a character', () => {
        setupSearch();

        expect(press('/')).toBe(true);
        expect(focused()).toBe('search');
        expect(press('/', element('search'))).toBe(false);
        expect(focused()).toBe('search');
    });

    it('does not take the key from the editor', () => {
        setupSearch();
        element('editor').focus();

        expect(press('/', element('editor'))).toBe(false);
        expect(focused()).toBe('editor');
    });
});
