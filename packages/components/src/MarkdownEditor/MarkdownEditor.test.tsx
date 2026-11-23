// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MarkdownEditor, type MarkdownEditorProps } from './MarkdownEditor';
import { MARKDOWN_MAX_BYTES, markdownSupport } from './markdownDocument';

import type { Editor } from '@tiptap/core';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

async function render(props: MarkdownEditorProps) {
    await act(async () => root.render(<MarkdownEditor {...props} />));
}

function mountedEditor(): Editor {
    return (host.querySelector('[contenteditable="true"]') as HTMLElement & { editor: Editor }).editor;
}

/** Types `text` at the end of the document, as a user would. */
async function typeAtEnd(text: string) {
    const editor = mountedEditor();

    await act(async () => {
        editor.chain().focus('end').insertContent(text).run();
    });
}

/** A mouse press, as React Aria listens for it. */
async function press(element: Element) {
    await act(async () => {
        const pointer = {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            pointerType: 'mouse',
            button: 0,
            width: 1,
            height: 1,
            pressure: 0.5,
            detail: 1,
        };

        element.dispatchEvent(new PointerEvent('pointerdown', pointer));
        element.dispatchEvent(new PointerEvent('pointerup', pointer));
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
    });
}

// Each sample is already in the editor's canonical form, so it comes back unchanged.
const FEATURES: Record<string, string> = {
    headings: '# Title\n\n## Section\n\n### Detail',
    inline: 'Some **bold**, *italic*, ~~struck~~, `code` and [a link](https://example.com).',
    'bullet list': '- one\n- two',
    'numbered list': '1. one\n2. two',
    'task list': '- [ ] todo\n- [x] done',
    blockquote: '> quoted',
    'horizontal rule': 'above\n\n---\n\nbelow',
    'code block': '```ts\nconst answer = 42;\n```',
    image: '![Diagram](./images/diagram.png)',
};

describe('MarkdownEditor', () => {
    it.each(Object.entries(FEATURES))('should round-trip %s', async (_name, markdown) => {
        expect(markdownSupport(markdown)).toEqual({ supported: true });
        await render({ value: markdown });

        expect(mountedEditor().getMarkdown()).toBe(markdown);
    });

    // Tables come back padded, so the check is on the cells instead of the text.
    it('should round-trip a table', async () => {
        const cells = () => [...host.querySelectorAll('th, td')].map(cell => cell.textContent);

        await render({ value: '| Name | Size |\n| --- | --- |\n| a.md | 1 KB |\n' });
        expect(cells()).toEqual(['Name', 'Size', 'a.md', '1 KB']);

        await render({ value: mountedEditor().getMarkdown() });
        expect(cells()).toEqual(['Name', 'Size', 'a.md', '1 KB']);
    });

    it('should highlight code blocks once the language loads', async () => {
        await render({ value: '```ts\nconst answer = 42;\n```' });
        await vi.waitFor(() => {
            expect(host.querySelector('pre span[class]')).not.toBeNull();
        });
    });

    it('should take no edits and show no toolbar when not editable', async () => {
        const onChange = vi.fn();
        const prose = () => host.querySelector('.ProseMirror')!;

        await render({ value: '- [ ] todo\n', onChange, editable: false });
        await act(async () => (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click());

        expect(prose().getAttribute('contenteditable')).toBe('false');
        expect(host.querySelector('[role="toolbar"]')).toBeNull();
        expect(onChange).not.toHaveBeenCalled();

        await render({ value: '- [ ] todo\n', onChange, editable: true });

        expect(prose().getAttribute('contenteditable')).toBe('true');
        expect(host.querySelector('[role="toolbar"]')).not.toBeNull();
    });

    describe('placeholder', () => {
        const hint = () => host.querySelector<HTMLElement>('p.is-editor-empty[data-placeholder]');

        it("should mark the empty document's paragraph with the hint, and leave it out of the markdown", async () => {
            const onChange = vi.fn();

            await render({ value: '', placeholder: 'Add a description', onChange });

            expect(hint()?.dataset.placeholder).toBe('Add a description');
            expect(mountedEditor().getMarkdown()).toBe('');
            expect(onChange).not.toHaveBeenCalled();
        });

        it('should drop the hint while there is text, bring it back when the text is gone, and never write it', async () => {
            const onChange = vi.fn();

            await render({ value: '', placeholder: 'Add a description', onChange });
            await typeAtEnd('Plain text');

            expect(hint()).toBeNull();
            expect(onChange).toHaveBeenLastCalledWith('Plain text');
            expect(host.textContent).not.toContain('Add a description');

            // The owner of the text follows the editor, then the text is emptied from outside.
            await render({ value: 'Plain text', placeholder: 'Add a description', onChange });
            await render({ value: '', placeholder: 'Add a description', onChange });

            expect(hint()?.dataset.placeholder).toBe('Add a description');
        });

        it('should show the hint over an empty value that came with front matter only', async () => {
            await render({ value: '---\ntitle: x\n---\n', placeholder: 'Add a description' });

            expect(hint()).not.toBeNull();
        });

        it('should add nothing to an editor without it', async () => {
            await render({ value: '' });

            expect(host.querySelector('[data-placeholder]')).toBeNull();
            expect(host.querySelector('.is-editor-empty, .is-empty')).toBeNull();
        });

        it('should not show it where the text cannot be edited', async () => {
            await render({ value: '', placeholder: 'Add a description', editable: false });

            expect(hint()).toBeNull();
        });
    });

    it('should apply markdown input rules and formatting shortcuts', async () => {
        const onChange = vi.fn();

        await render({ value: '', onChange });
        const editor = mountedEditor();
        const typeText = (text: string) => {
            const { from, to } = editor.state.selection;

            editor.view.someProp('handleTextInput', handle =>
                handle(editor.view, from, to, text, () => editor.state.tr.insertText(text, from, to))
            ) || editor.view.dispatch(editor.state.tr.insertText(text, from, to));
        };
        const mac = /Mac|iP(hone|[oa]d)/.test(navigator.platform);

        await act(async () => {
            editor.commands.focus();
            for (const char of '## Title') {
                typeText(char);
            }

            editor.commands.selectAll();
            editor.view.someProp('handleKeyDown', handle =>
                handle(editor.view, new KeyboardEvent('keydown', { key: 'b', metaKey: mac, ctrlKey: !mac }))
            );
        });

        expect(onChange).toHaveBeenLastCalledWith('## **Title**');
    });

    it('should make a quote on Cmd+Shift+., and on Cmd+Shift+B on a Mac, where the desktop app keeps Ctrl+Shift+B off a Mac for its side panel', async () => {
        const onChange = vi.fn();

        await render({ value: 'quoted', onChange });

        const editor = mountedEditor();
        const mac = /Mac|iP(hone|[oa]d)/.test(navigator.platform);
        const key = (init: KeyboardEventInit & { keyCode: number }) => {
            const event = new KeyboardEvent('keydown', {
                shiftKey: true,
                metaKey: mac,
                ctrlKey: !mac,
                bubbles: true,
                cancelable: true,
                ...init,
            });

            // A key event of a real browser has its `keyCode`, which the editor's keymap falls back on when a modifier changes what the key types.
            Object.defineProperty(event, 'keyCode', { value: init.keyCode });
            editor.view.someProp('handleKeyDown', handle => handle(editor.view, event));
        };

        await act(async () => {
            editor.commands.focus('end');
            key({ key: 'B', code: 'KeyB', keyCode: 66 });
        });

        // TipTap's own key makes the quote on a Mac, and is the app's off it, where the editor leaves it alone.
        expect(editor.isActive('blockquote')).toBe(mac);
        expect(onChange).toHaveBeenCalledTimes(mac ? 1 : 0);

        await act(async () => {
            key({ key: 'B', code: 'KeyB', keyCode: 66 });
        });

        expect(editor.isActive('blockquote')).toBe(false);

        await act(async () => {
            key({ key: '>', code: 'Period', keyCode: 190 });
        });

        expect(editor.isActive('blockquote')).toBe(true);
        expect(onChange).toHaveBeenLastCalledWith('> quoted');

        await act(async () => {
            key({ key: '>', code: 'Period', keyCode: 190 });
        });

        expect(editor.isActive('blockquote')).toBe(false);
    });

    it('should never emit or add an undo step on load or when the value is replaced', async () => {
        const onChange = vi.fn();

        await render({ value: '# One\n\n- [ ] task\n', onChange });
        await render({ value: '# Two\n', onChange });
        await act(async () => {
            mountedEditor().commands.undo();
        });

        expect(mountedEditor().getMarkdown()).toBe('# Two');
        expect(onChange).not.toHaveBeenCalled();
    });

    it('should show images through resolveImageSrc and keep the written path', async () => {
        await render({ value: '![Diagram](./diagram.png)\n', resolveImageSrc: async src => `blob:${src}` });

        await vi.waitFor(() => {
            expect(host.querySelector('img[alt="Diagram"]')?.getAttribute('src')).toBe('blob:./diagram.png');
        });
        expect(mountedEditor().getMarkdown()).toBe('![Diagram](./diagram.png)');
    });

    it('should emit the edited markdown and keep the editor state when the emit comes back', async () => {
        const onChange = vi.fn();

        await render({ value: '# Notes\n', onChange });
        await typeAtEnd('!');

        expect(onChange).toHaveBeenCalledExactlyOnceWith('# Notes!\n');

        const doc = mountedEditor().state.doc;

        await render({ value: '# Notes!\n', onChange });

        expect(mountedEditor().state.doc).toBe(doc);
    });

    it('should keep how untouched blocks are written when an edit changes another one', async () => {
        const onChange = vi.fn();
        const written = '* one\n* two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nSome _text_ here.\n';

        await render({ value: written, onChange });
        await typeAtEnd('!');

        expect(onChange).toHaveBeenLastCalledWith(
            '* one\n* two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nSome _text_ here.!\n'
        );

        const doc = mountedEditor().state.doc;

        await render({ value: onChange.mock.lastCall![0], onChange });
        expect(mountedEditor().state.doc).toBe(doc);

        await typeAtEnd('?');
        expect(onChange).toHaveBeenLastCalledWith(
            '* one\n* two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nSome _text_ here.!?\n'
        );
    });

    it('should keep how the file is written after a change that leaves the document equal', async () => {
        const onChange = vi.fn();

        await render({ value: '* one\n\nSome _text_ here.\n', onChange });
        const editor = mountedEditor();

        // Typing a selected character over itself: a new document with equal content, and no update.
        await act(async () => {
            editor.view.dispatch(editor.state.tr.insertText('o', 3, 4));
        });
        await typeAtEnd('!');

        expect(onChange).toHaveBeenCalledExactlyOnceWith('* one\n\nSome _text_ here.!\n');
    });

    it('should keep an empty first paragraph under front matter when its emit comes back', async () => {
        const onChange = vi.fn();

        await render({ value: '---\ntitle: Guide\n---\n# Title\n', onChange });
        const editor = mountedEditor();

        await act(async () => {
            editor.chain().focus('start').insertContentAt(0, { type: 'paragraph' }).run();
        });
        const doc = editor.state.doc;

        await render({ value: onChange.mock.lastCall![0], onChange });
        expect(mountedEditor().state.doc).toBe(doc);

        await act(async () => {
            mountedEditor().chain().focus('start').insertContent('Intro').run();
        });
        expect(onChange).toHaveBeenLastCalledWith('---\ntitle: Guide\n---\nIntro\n\n# Title\n');
    });

    it('should start the body on its own line under front matter that ends the file without a newline', async () => {
        const onChange = vi.fn();

        await render({ value: '---\ntitle: Guide\n---', onChange });
        await typeAtEnd('Intro');

        expect(onChange).toHaveBeenLastCalledWith('---\ntitle: Guide\n---\nIntro');
    });

    it('should show the block style at the cursor and set another from the text style menu', async () => {
        const onChange = vi.fn();
        // Rows follow the style order: text, then heading 1 to 6.
        const items = () => [...document.querySelectorAll('[role="menuitemradio"]')];

        await render({ value: '## Notes\n', onChange });
        await act(async () => {
            mountedEditor().commands.focus('end');
        });
        await press(host.querySelector('[role="toolbar"] button[aria-haspopup]')!);

        expect(items().findIndex(row => row.getAttribute('aria-checked') === 'true')).toBe(2);

        await press(items()[1]!);

        expect(onChange).toHaveBeenLastCalledWith('# Notes\n');
        expect(document.querySelector('[role="menu"]')).toBeNull();
    });

    it('should set and remove a link through the link popover', async () => {
        const onChange = vi.fn();
        const linkButton = () => [...host.querySelectorAll('[role="toolbar"] button')].at(-1)!;

        await render({ value: 'Read the guide\n', onChange });
        await act(async () => {
            mountedEditor().commands.setTextSelection({ from: 10, to: 15 });
        });
        await press(linkButton());
        const input = document.querySelector<HTMLInputElement>('form input')!;

        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, './guide.md');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => {
            input.form!.requestSubmit();
        });

        expect(onChange).toHaveBeenLastCalledWith('Read the [guide](./guide.md)\n');

        await press(linkButton());
        await press(document.querySelector('form button:not([type="submit"])')!);

        expect(onChange).toHaveBeenLastCalledWith('Read the guide\n');
    });

    it.each([
        ['YAML', '---\ntitle: Guide\ntags: [a, b]\n---\n\n', 'Intro\n', 'title: Guide\ntags: [a, b]'],
        ['empty YAML', '---\n---\n', '', undefined],
        ['TOML', '+++\ntitle = "Guide"\n+++\n', 'Intro\n', 'title = "Guide"'],
    ])(
        'should show %s front matter read-only, without its delimiters, and emit it unchanged',
        async (_name, frontMatter, body, shown) => {
            const onChange = vi.fn();

            await render({ value: frontMatter + body, onChange });

            expect(host.querySelector('figure pre')?.textContent).toBe(shown);
            expect(mountedEditor().getMarkdown()).toBe(body.trimEnd());

            await typeAtEnd('.');

            expect(onChange).toHaveBeenCalledExactlyOnceWith(`${frontMatter}${body.trimEnd()}.\n`);
        }
    );

    it.each([
        ['raw HTML', '<div align="center">Logo</div>\n'],
        ['footnotes', 'Claim.[^1]\n\n[^1]: Source.\n'],
        ['footnotes with a sentence', 'Claim.[^1]\n\n[^1]: Some source text.\n'],
        ['numbered task lists', '1. [ ] todo\n2. [x] done\n'],
        ['a heading inside a list item', '- # Title\n'],
        ['reference links', 'See [the docs][docs].\n\n[docs]: https://example.com\n'],
        ['named HTML entities', 'Copyright &copy; 2026\n'],
    ])('should show %s read-only with the reason in place of the toolbar', async (_name, markdown) => {
        const onChange = vi.fn();
        const prose = () => host.querySelector('.ProseMirror')!;

        await render({ value: markdown, onChange, unsupportedAction: <button type="button">Edit as source</button> });

        expect(prose().getAttribute('contenteditable')).toBe('false');
        expect(prose().textContent).toMatch(/\S/);
        expect(host.querySelector('[role="toolbar"]')).toBeNull();
        expect(host.querySelector('button')?.parentElement?.textContent).toMatch(/^\S.*Edit as source$/);
        await act(async () => (host.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.click());
        expect(onChange).not.toHaveBeenCalled();

        // A later value the editor can keep is editable again.
        await render({ value: 'Plain text\n', onChange });

        expect(prose().getAttribute('contenteditable')).toBe('true');
        expect(host.querySelector('[role="toolbar"]')).not.toBeNull();
    });

    it('should refuse an oversized file with a reason and render no editor', async () => {
        const onUnsupported = vi.fn();

        await render({ value: 'a'.repeat(MARKDOWN_MAX_BYTES + 1), onUnsupported });

        expect(onUnsupported).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/\S/));
        expect(host.querySelector('[contenteditable]')).toBeNull();
    });
});
