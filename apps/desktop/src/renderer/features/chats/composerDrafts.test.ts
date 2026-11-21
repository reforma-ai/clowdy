import { docToPlainText, emptyComposerDoc, plainTextToDoc, type ComposerDoc } from '@clowdy/components/RichInput';
import { describe, expect, it } from 'vitest';

import { messageOf, withQuoteLast } from './composerDrafts';

/** What the doc writes, with the line break a hard break writes (a Markdown line break) shown as the newline it is. */
const written = (doc: ComposerDoc) => docToPlainText(doc).replaceAll('  \n', '\n');

/** The draft with `words` typed into its last paragraph, as the person does under a quote. */
const typed = (doc: ComposerDoc, words: string): ComposerDoc => ({ ...doc, content: [...doc.content!.slice(0, -1), plainTextToDoc(words).content![0]] });

describe('withQuoteLast', () => {
    it('puts a one-line quote in an empty draft, trimmed, with an empty paragraph after it for the caret', () => {
        const next = withQuoteLast(emptyComposerDoc(), '  hello world  ');

        expect(next.content).toEqual([{ type: 'paragraph', content: [{ type: 'text', text: '> hello world' }] }, { type: 'paragraph' }]);
    });

    it('prefixes each line of a longer quote and writes a blank line as a bare `>`', () => {
        expect(written(withQuoteLast(emptyComposerDoc(), 'para one\n\npara two'))).toBe('> para one\n>\n> para two\n\n');
    });

    it('reads Windows and old Mac line ends as lines', () => {
        expect(written(withQuoteLast(emptyComposerDoc(), 'one\r\ntwo\rthree'))).toBe('> one\n> two\n> three\n\n');
    });

    it('leaves out the blank lines between two lines that are quotes already', () => {
        expect(written(withQuoteLast(emptyComposerDoc(), '> one\n\n> two'))).toBe('> > one\n> > two\n\n');
        // A blank line next to a line that is not a quote stays.
        expect(written(withQuoteLast(emptyComposerDoc(), '> one\n\ntwo'))).toBe('> > one\n>\n> two\n\n');
    });

    it('writes a line of blanks as a bare `>` too', () => {
        expect(written(withQuoteLast(emptyComposerDoc(), 'one\n   \ntwo'))).toBe('> one\n>\n> two\n\n');
    });

    it('puts the quote in a paragraph of its own after the words that are there, with a blank line between', () => {
        expect(written(withQuoteLast(plainTextToDoc('existing reply'), 'quoted'))).toBe('existing reply\n\n> quoted\n\n');
    });

    it('stacks a second quote below the first, with a blank line between and one empty paragraph after', () => {
        const first = withQuoteLast(emptyComposerDoc(), 'first');
        const both = withQuoteLast(first, 'second');

        expect(written(both)).toBe('> first\n\n> second\n\n');
        expect(both.content).toHaveLength(3);
        expect(messageOf(withQuoteLast(both, 'third'))).toBe('> first\n\n> second\n\n> third');
    });

    it('keeps a blank line between two quotes when the paragraph after the first was deleted', () => {
        const first = withQuoteLast(emptyComposerDoc(), 'first');
        const deleted: ComposerDoc = { ...first, content: first.content!.slice(0, 1) };

        expect(written(withQuoteLast(deleted, 'second'))).toBe('> first\n\n> second\n\n');
    });

    it('takes the empty paragraphs that end the draft for the place of the quote, and leaves the ones between', () => {
        const words: ComposerDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'paragraph' }, { type: 'paragraph', content: [{ type: 'text', text: 'b' }] }, { type: 'paragraph' }, { type: 'paragraph' }] };

        expect(written(withQuoteLast(words, 'q'))).toBe('a\n\n\n\nb\n\n> q\n\n');
    });

    it('replaces a draft of blanks, which sends nothing', () => {
        expect(written(withQuoteLast(plainTextToDoc('  '), 'quoted'))).toBe('> quoted\n\n');
    });

    it('gives the draft back as it is when there is nothing to quote', () => {
        const draft = plainTextToDoc('words');

        expect(withQuoteLast(draft, '')).toBe(draft);
        expect(withQuoteLast(draft, '   \n  ')).toBe(draft);
        expect(withQuoteLast(emptyComposerDoc(), '\n\t')).toEqual(emptyComposerDoc());
    });

    it('keeps what was in the draft as it was, a mention chip included, and adds only after it', () => {
        const mention = { type: 'composerMention', attrs: { id: 'src/a.ts', label: 'a.ts', kind: 'file', data: null, mentionSuggestionChar: '@' } };
        const draft: ComposerDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Look at ' }, mention] }] };
        const next = withQuoteLast(draft, 'context');

        expect(next.content).toHaveLength(3);
        expect(next.content![0]).toBe(draft.content![0]);
        expect(next.content![1]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: '> context' }] });
        expect(next.content![0].content).toEqual([{ type: 'text', text: 'Look at ' }, mention]);
        // The draft that came in is not touched.
        expect(draft.content).toHaveLength(1);
    });

    it('writes the lines as hard breaks of one paragraph, never as a newline inside a text node or a paragraph per line', () => {
        const next = withQuoteLast(emptyComposerDoc(), 'one\ntwo\n\nthree');
        const inline = next.content![0].content!;

        expect(next.content).toHaveLength(2);
        expect(inline.filter(node => node.type === 'text').map(node => node.text)).toEqual(['> one', '> two', '>', '> three']);
        expect(inline.filter(node => node.type === 'hardBreak')).toHaveLength(3);
        expect(inline.some(node => node.type === 'text' && node.text?.includes('\n'))).toBe(false);
        expect(inline.at(-1)?.type).toBe('text');
    });

    it('puts the quote in a paragraph of its own after a list', () => {
        const list: ComposerDoc = {
            type: 'doc',
            content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }] }] }],
        };
        const next = withQuoteLast(list, 'quoted');

        expect(next.content).toHaveLength(3);
        expect(next.content![0]).toBe(list.content![0]);
        expect(next.content![1].type).toBe('paragraph');
        expect(written(next)).toBe('- item\n\n> quoted\n\n');
    });

    it('reads as the Markdown the message box sends: the lines of the quote joined by line breaks, and nothing after it when nothing is typed', () => {
        const next = withQuoteLast(emptyComposerDoc(), 'one\ntwo');

        expect(messageOf(next)).toBe('> one  \n> two');
        expect(messageOf(withQuoteLast(plainTextToDoc('words'), 'one'))).toBe('words\n\n> one');
    });

    it('sends a reply typed under the quote after a blank line, so it is not a part of the quote', () => {
        const quoted = withQuoteLast(emptyComposerDoc(), 'quote');

        expect(messageOf(typed(quoted, 'reply'))).toBe('> quote\n\nreply');
        expect(messageOf(typed(withQuoteLast(quoted, 'second'), 'reply'))).toBe('> quote\n\n> second\n\nreply');
    });
});
