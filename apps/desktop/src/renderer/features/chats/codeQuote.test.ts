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

    it('quotes a huge text of backtick runs: it is cut first, so the count of runs stays below what the fence\'s longest-run search takes as arguments', () => {
        const quoted = codeQuote('big.js', { from: 1, to: 1, text: '`a'.repeat(200_000) });

        expect(quoted.startsWith('`big.js:1`\n```js\n')).toBe(true);
    });

    it('quotes a selection up to the last whole line that fits, names the lines quoted, and says where the selection goes on to', () => {
        const line = `${ 'x'.repeat(98) }\n`;
        const text = line.repeat(1500).trimEnd();
        const quoted = codeQuote('lock.json', { from: 11, to: 1510, text });
        const [head = '', , ...rest] = quoted.split('\n');
        const code = rest.slice(0, -2);

        // 99 characters a line and room for 1010 of them in 100,000.
        expect(head).toBe('`lock.json:11-1020`');
        expect(code).toHaveLength(1010);
        expect(code.every(row => row === 'x'.repeat(98))).toBe(true);
        expect(rest.at(-2)).toBe('```');
        expect(rest.at(-1)).toBe('… the selection goes on to line 1510');
        expect(quoted.length).toBeLessThan(100_200);
    });

    it('cuts a single line longer than the limit where it is, and still names the line', () => {
        const quoted = codeQuote('min.js', { from: 3, to: 3, text: 'a'.repeat(150_000) });

        expect(quoted.startsWith('`min.js:3`\n```js\n')).toBe(true);
        expect(quoted.endsWith('\n```\n… the selection goes on to line 3')).toBe(true);
        expect(quoted.length).toBeLessThan(100_200);
    });

    it('leaves a selection that fits whole, with nothing after the block', () => {
        const text = 'x'.repeat(99_999);

        expect(codeQuote('a.js', { from: 1, to: 1, text })).toBe(`\`a.js:1\`\n\`\`\`js\n${ text }\n\`\`\``);
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
