import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import HardBreak from '@tiptap/extension-hard-break';
import { ListKit } from '@tiptap/extension-list';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { Window } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';

import { handleComposerKeyDown } from './composerKeymap';

import type { JSONContent } from '@tiptap/core';

function withDom<T>(run: () => T): T {
    const window = new Window();
    const prev = {
        window: globalThis.window,
        document: globalThis.document,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        cancelAnimationFrame: globalThis.cancelAnimationFrame,
        KeyboardEvent: globalThis.KeyboardEvent,
    };

    Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
    Object.defineProperty(globalThis, 'document', { value: window.document, configurable: true });
    globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
    globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
    globalThis.KeyboardEvent = window.KeyboardEvent;

    try {
        return run();
    } finally {
        Object.defineProperty(globalThis, 'window', { value: prev.window, configurable: true });
        Object.defineProperty(globalThis, 'document', { value: prev.document, configurable: true });
        globalThis.requestAnimationFrame = prev.requestAnimationFrame;
        globalThis.cancelAnimationFrame = prev.cancelAnimationFrame;
        globalThis.KeyboardEvent = prev.KeyboardEvent;
        window.close();
    }
}

function bulletDoc(items: string[]): JSONContent {
    return {
        type: 'doc',
        content: [
            {
                type: 'bulletList',
                content: items.map(text => ({
                    type: 'listItem',
                    content: [
                        {
                            type: 'paragraph',
                            ...(text ? { content: [{ type: 'text', text }] } : {}),
                        },
                    ],
                })),
            },
        ],
    };
}

function createEditor(content: JSONContent): Editor {
    const mount = document.createElement('div');

    document.body.append(mount);

    return new Editor({
        element: { mount },
        extensions: [
            Document,
            Paragraph,
            Text,
            HardBreak.extend({
                addKeyboardShortcuts() {
                    return {};
                },
            }),
            ListKit.configure({ taskItem: false, taskList: false }),
        ],
        content,
        injectCSS: false,
    });
}

function shiftEnter(): KeyboardEvent {
    return new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true });
}

function enter(): KeyboardEvent {
    return new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
}

function modEnter(): KeyboardEvent {
    return new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true });
}

describe('handleComposerKeyDown list Shift+Enter', () => {
    it('should create the next list item from a filled bullet', () => {
        withDom(() => {
            const editor = createEditor(bulletDoc(['hello']));

            editor.commands.setTextSelection(editor.state.doc.content.size - 1);

            const handled = handleComposerKeyDown(editor.view, shiftEnter(), {
                submitOnEnter: true,
            });

            expect(handled).toBe(true);
            expect(editor.getJSON()).toEqual(bulletDoc(['hello', '']));

            editor.destroy();
        });
    });

    it('should drop an empty bullet back to a paragraph', () => {
        withDom(() => {
            const editor = createEditor(bulletDoc(['hello', '']));

            editor.commands.setTextSelection(editor.state.doc.content.size - 1);

            const handled = handleComposerKeyDown(editor.view, shiftEnter(), {
                submitOnEnter: true,
            });

            expect(handled).toBe(true);
            expect(editor.getJSON()).toEqual({
                type: 'doc',
                content: [
                    {
                        type: 'bulletList',
                        content: [
                            {
                                type: 'listItem',
                                content: [
                                    {
                                        type: 'paragraph',
                                        content: [{ type: 'text', text: 'hello' }],
                                    },
                                ],
                            },
                        ],
                    },
                    { type: 'paragraph' },
                ],
            });

            editor.destroy();
        });
    });
});

describe('handleComposerKeyDown submit', () => {
    it('should submit on Enter without a modifier', () => {
        withDom(() => {
            const editor = createEditor({ type: 'doc', content: [{ type: 'paragraph' }] });
            const onSubmit = vi.fn();

            const handled = handleComposerKeyDown(editor.view, enter(), {
                submitOnEnter: true,
                hasMenuItems: false,
                onSubmit,
            });

            expect(handled).toBe(true);
            expect(onSubmit).toHaveBeenCalledWith({ mod: false });

            editor.destroy();
        });
    });

    it('should submit on Cmd+Enter as an immediate send', () => {
        withDom(() => {
            const editor = createEditor({ type: 'doc', content: [{ type: 'paragraph' }] });
            const onSubmit = vi.fn();

            const handled = handleComposerKeyDown(editor.view, modEnter(), {
                submitOnEnter: true,
                hasMenuItems: false,
                onSubmit,
            });

            expect(handled).toBe(true);
            expect(onSubmit).toHaveBeenCalledWith({ mod: true });

            editor.destroy();
        });
    });
});

describe('handleComposerKeyDown escape', () => {
    const escape = () => new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });

    it('should close an open suggestion menu and leave onEscape alone, so a menu goes before whatever Escape would stop', () => {
        withDom(() => {
            const editor = createEditor({ type: 'doc', content: [{ type: 'paragraph' }] });
            const onEscape = vi.fn();
            const closeMenu = vi.fn();

            const handled = handleComposerKeyDown(editor.view, escape(), {
                submitOnEnter: true,
                hasMenuItems: true,
                onEscape,
                closeMenu,
            });

            expect(handled).toBe(true);
            expect(closeMenu).toHaveBeenCalledOnce();
            expect(onEscape).not.toHaveBeenCalled();

            editor.destroy();
        });
    });

    it('should call onEscape when no menu is open, and not claim the key, so the other handlers of the page still see it', () => {
        withDom(() => {
            const editor = createEditor({ type: 'doc', content: [{ type: 'paragraph' }] });
            const onEscape = vi.fn();
            const closeMenu = vi.fn();

            const handled = handleComposerKeyDown(editor.view, escape(), {
                submitOnEnter: true,
                hasMenuItems: false,
                onEscape,
                closeMenu,
            });

            expect(handled).toBe(false);
            expect(onEscape).toHaveBeenCalledOnce();
            expect(closeMenu).not.toHaveBeenCalled();

            editor.destroy();
        });
    });
});
