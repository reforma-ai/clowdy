import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';

import { shouldYieldRichInputAutofocus } from './RichInput';

function withDom(run: (document: Document) => void): void {
    const window = new Window();
    const prev = {
        window: globalThis.window,
        document: globalThis.document,
        HTMLIFrameElement: globalThis.HTMLIFrameElement,
    };

    Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
    Object.defineProperty(globalThis, 'document', { value: window.document, configurable: true });
    globalThis.HTMLIFrameElement = window.HTMLIFrameElement;

    try {
        run(window.document);
    } finally {
        Object.defineProperty(globalThis, 'window', { value: prev.window, configurable: true });
        Object.defineProperty(globalThis, 'document', { value: prev.document, configurable: true });
        globalThis.HTMLIFrameElement = prev.HTMLIFrameElement;
    }
}

describe('shouldYieldRichInputAutofocus', () => {
    it('should autofocus on first mount', () => {
        withDom(document => {
            const field = document.createElement('textarea');

            document.body.append(field);
            field.focus();

            expect(shouldYieldRichInputAutofocus(null)).toBe(false);
        });
    });

    it('should keep focus in another textarea, input, or contenteditable', () => {
        withDom(document => {
            const own = document.createElement('div');
            const textarea = document.createElement('textarea');
            const input = document.createElement('input');
            const comment = document.createElement('div');

            comment.setAttribute('contenteditable', 'true');
            document.body.append(own, textarea, input, comment);

            textarea.focus();
            expect(shouldYieldRichInputAutofocus(own)).toBe(true);

            input.focus();
            expect(shouldYieldRichInputAutofocus(own)).toBe(true);

            comment.focus();
            expect(shouldYieldRichInputAutofocus(own)).toBe(true);
        });
    });

    it('should keep focus in a code editor', () => {
        withDom(document => {
            const own = document.createElement('div');
            const code = document.createElement('div');

            code.className = 'cm-editor';
            code.tabIndex = 0;
            document.body.append(own, code);
            code.focus();

            expect(shouldYieldRichInputAutofocus(own)).toBe(true);
        });
    });

    it('should keep focus in a code editor inside a frame', () => {
        withDom(document => {
            const own = document.createElement('div');
            const frame = document.createElement('iframe');

            // happy-dom loads no iframe page, so a frame has no `contentDocument`; `srcdoc` gives it a document of its own without a page load.
            frame.setAttribute('srcdoc', '<body></body>');
            document.body.append(own, frame);

            const area = frame.contentDocument!.createElement('textarea');

            frame.tabIndex = 0;
            frame.contentDocument!.body.append(area);
            area.focus();
            frame.focus();

            expect(document.activeElement).toBe(frame);
            expect(shouldYieldRichInputAutofocus(own)).toBe(true);
        });
    });

    it('should still autofocus when focus is already in this field', () => {
        withDom(document => {
            const own = document.createElement('div');

            own.setAttribute('contenteditable', 'true');
            document.body.append(own);
            own.focus();

            expect(shouldYieldRichInputAutofocus(own)).toBe(false);
        });
    });

    it('should still autofocus when focus is not in a text field', () => {
        withDom(document => {
            const own = document.createElement('div');
            const button = document.createElement('button');

            document.body.append(own, button);
            button.focus();

            expect(shouldYieldRichInputAutofocus(own)).toBe(false);
        });
    });
});
