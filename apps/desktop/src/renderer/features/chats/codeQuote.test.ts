import { emptyComposerDoc } from '@clowdy/components/RichInput';
import { describe, expect, it } from 'vitest';

import { codeQuote } from './codeQuote';
import { messageOf, quotedMessage, withQuoteLast } from './composerDrafts';

describe('codeQuote', () => {
    it('names the path and the lines, then fences the words with the language of the file', () => {
        expect(codeQuote('src/a.ts', { from: 10, to: 12, text: 'const a = 1;\nconst b = 2;\nconst c = 3;' }))
            .toBe('`src/a.ts:10-12`\n```ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```');
    });

    it('names one line once', () => {
        expect(codeQuote('README.md', { from: 7, to: 7, text: 'Words' })).toBe('`README.md:7`\n```md\nWords\n```');
    });

    it('keeps indentation and the blank lines inside the words', () => {
        const text = '    if (ok) {\n\n        run();\n    }';

        expect(codeQuote('x.js', { from: 3, to: 6, text })).toBe(`\`x.js:3-6\`\n\`\`\`js\n${ text }\n\`\`\``);
    });

    it('opens no fence on an empty line and leaves no blank space at the end', () => {
        expect(codeQuote('a.py', { from: 1, to: 2, text: '\n\nx = 1\ny = 2  \n\n' })).toBe('`a.py:1-2`\n```py\nx = 1\ny = 2\n```');
    });

    it('writes a fence the words cannot close', () => {
        expect(codeQuote('notes.md', { from: 1, to: 3, text: '```ts\nlet a;\n```' })).toBe('`notes.md:1-3`\n````md\n```ts\nlet a;\n```\n````');
    });

    it('names no language for a file with no extension', () => {
        expect(codeQuote('Dockerfile', { from: 1, to: 1, text: 'FROM bun' })).toBe('`Dockerfile:1`\n```\nFROM bun\n```');
    });

    it('lands in a draft as a quote that reads on its own, with a paragraph under it for the caret', () => {
        const doc = withQuoteLast(emptyComposerDoc(), codeQuote('src/a.ts', { from: 4, to: 5, text: '  a();\n  b();' }));

        expect(messageOf(doc)).toBe('> `src/a.ts:4-5`  \n> ```ts  \n>   a();  \n>   b();  \n> ```');
        expect(doc.content?.at(-1)).toEqual({ type: 'paragraph' });
    });

    it('is sent as the quote, a blank line, and what was typed under it', () => {
        expect(quotedMessage(codeQuote('src/a.ts', { from: 4, to: 4, text: 'a();' }), 'Why is this called twice?'))
            .toBe('> `src/a.ts:4`  \n> ```ts  \n> a();  \n> ```\n\nWhy is this called twice?');
    });
});
