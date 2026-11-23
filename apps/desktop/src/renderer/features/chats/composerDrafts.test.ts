import { docToPlainText, emptyComposerDoc, plainTextToDoc, type ComposerDoc } from '@clowdy/components/RichInput';
import { describe, expect, it } from 'vitest';

import { docOfMessage, draftOf, dropDraft, editDraftKey, messageOf, newChatDraftKey, quotedMessage, saveDraft, withQuoteLast } from './composerDrafts';

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

    it('keeps the blank lines of a fenced block of code, where they are the code\'s own', () => {
        const code = '`a.md:1-3`\n```md\n> one\n\n> two\n```\n\n> three\n\n> four';

        // The blank line inside the block stays; the one between the two quotes after it is left out, as before.
        expect(written(withQuoteLast(emptyComposerDoc(), code))).toBe('> `a.md:1-3`\n> ```md\n> > one\n>\n> > two\n> ```\n>\n> > three\n> > four\n\n');
    });

    it('closes a fenced block only with a fence at least as long, so a shorter one inside it is code', () => {
        const code = '````md\n> one\n```\n\n> two\n````\n\n> three\n\n> four';

        expect(written(withQuoteLast(emptyComposerDoc(), code))).toBe('> ````md\n> > one\n> ```\n>\n> > two\n> ````\n>\n> > three\n> > four\n\n');
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

describe('docOfMessage', () => {
    it('makes a paragraph of each run of text between blank lines, as the message box writes what is typed, and a line break of a single newline', () => {
        const doc = docOfMessage('first line\nsecond line\n\nsecond paragraph');

        expect(doc.content).toHaveLength(2);
        expect(doc.content![0].content!.map(node => node.type)).toEqual(['text', 'hardBreak', 'text']);
        expect(doc.content![1].content).toEqual([{ type: 'text', text: 'second paragraph' }]);
    });

    it('gives back the words that were sent: a message that was not changed is sent as it was', () => {
        for (const sentText of ['Make the title bigger', 'one\n\ntwo\n\nthree', '> quote  \n> more\n\nreply']) {
            expect(messageOf(docOfMessage(sentText))).toBe(sentText);
        }
    });

    it('writes the lines of a list or a fence as lines of one paragraph, which the message box writes with a Markdown line break at the end of each', () => {
        expect(messageOf(docOfMessage('- one\n- two\n\nthen this'))).toBe('- one  \n- two\n\nthen this');
        expect(messageOf(docOfMessage('```ts\nconst a = 1;\n```'))).toBe('```ts  \nconst a = 1;  \n```');
    });

    it('does not add to the words each time a message is edited: the two spaces of a line break are written once', () => {
        const once = messageOf(docOfMessage('> a  \n> b'));

        expect(messageOf(docOfMessage(once))).toBe(once);
        expect(once).toBe('> a  \n> b');
    });

    it('reads blank lines that hold spaces, Windows line ends and extra blank lines as one break between paragraphs', () => {
        expect(messageOf(docOfMessage('one\r\n  \r\n\r\n\r\ntwo'))).toBe('one\n\ntwo');
    });

    it('is an empty draft for empty words', () => {
        expect(messageOf(docOfMessage(''))).toBe('');
        expect(messageOf(docOfMessage('  \n\n  '))).toBe('');
        expect(docOfMessage('').content).toEqual([{ type: 'paragraph' }]);
    });
});

describe('the key of an edit session', () => {
    it('is not the chat\'s id, and not the key of the new-chat page, so a draft under it is not the chat\'s', () => {
        const key = editDraftKey('c-1', 'i-4');

        expect(key).not.toBe('c-1');
        expect(key).not.toBe(newChatDraftKey('p-1'));
        // One per message, and one per chat for the same item id.
        expect(editDraftKey('c-1', 'i-5')).not.toBe(key);
        expect(editDraftKey('c-2', 'i-4')).not.toBe(key);
    });

    it('keeps a draft apart from the chat\'s, which dropDraft forgets alone', () => {
        const key = editDraftKey('c-drop', 'i-1');

        saveDraft('c-drop', plainTextToDoc('chat words'));
        saveDraft(key, plainTextToDoc('edit words'));
        dropDraft(key);

        expect(messageOf(draftOf(key))).toBe('');
        expect(messageOf(draftOf('c-drop'))).toBe('chat words');

        dropDraft('c-drop');
    });
});

describe('quotedMessage', () => {
    it('is the quote, a blank line and the words, so the words are not a part of the quote', () => {
        expect(quotedMessage('Use the blue one', 'Why?')).toBe('> Use the blue one\n\nWhy?');
    });

    it('is the quote alone when nothing was typed', () => {
        expect(quotedMessage('Use the blue one', '')).toBe('> Use the blue one');
    });

    it('writes the quote as a quote added to the draft does, a bare `>` for a blank line and hard breaks inside it', () => {
        const quoted = 'First paragraph\nsecond line\n\nSecond paragraph';

        // The same text as the draft would send for a selection quoted the same way, then the words after a blank line.
        expect(quotedMessage(quoted, 'Both')).toBe(`${ messageOf(withQuoteLast(emptyComposerDoc(), quoted)) }\n\nBoth`);
        expect(quotedMessage(quoted, 'Both')).toContain('> First paragraph  \n> second line  \n>  \n> Second paragraph');
    });

    it('leaves the words as they are when there is nothing to quote', () => {
        expect(quotedMessage('  \n ', 'Why?')).toBe('Why?');
        expect(quotedMessage('', '')).toBe('');
    });
});
