import { describe, expect, it } from 'vitest';

import { docToPlainText, emptyComposerDoc } from './composerDoc';

import type { ComposerDoc } from './types';

describe('docToPlainText', () => {
    it('should emit markdown for bold italic and inline code marks', () => {
        const doc: ComposerDoc = {
            type: 'doc',
            content: [{
                type: 'paragraph',
                content: [
                    { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
                    { type: 'text', text: ' ' },
                    { type: 'text', text: 'italic', marks: [{ type: 'italic' }] },
                    { type: 'text', text: ' ' },
                    { type: 'text', text: 'code', marks: [{ type: 'code' }] },
                ],
            }],
        };

        expect(docToPlainText(doc)).toBe('**bold** *italic* `code`');
    });

    it('should separate paragraphs with a blank line', () => {
        const doc: ComposerDoc = {
            type: 'doc',
            content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
                { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
            ],
        };

        expect(docToPlainText(doc)).toBe('one\n\ntwo');
    });

    it('should prefix bullet list items', () => {
        const doc: ComposerDoc = {
            type: 'doc',
            content: [{
                type: 'bulletList',
                content: [
                    { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'alpha' }] }] },
                    { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'beta' }] }] },
                ],
            }],
        };

        expect(docToPlainText(doc)).toBe('- alpha\n- beta');
    });

    it('should keep an empty doc empty', () => {
        expect(docToPlainText(emptyComposerDoc())).toBe('');
    });
});
