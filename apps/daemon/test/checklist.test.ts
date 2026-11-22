import { describe, expect, test } from 'bun:test';

import { parseChecklist } from '../src/domain/checklist';

describe('parseChecklist', () => {
    test('counts the ticked and all the items, and says nothing when there are none', () => {
        expect(parseChecklist('- [ ] one\n- [x] two\n- [X] three')).toEqual({ done: 2, total: 3 });
        expect(parseChecklist('- [ ] only')).toEqual({ done: 0, total: 1 });
        expect(parseChecklist('')).toBeUndefined();
        expect(parseChecklist('Outcome: x\n\n- a plain bullet\n- another')).toBeUndefined();
    });

    test('takes the three bullet marks, and a line break of either kind', () => {
        expect(parseChecklist('* [ ] star\n+ [x] plus\r\n- [x] dash')).toEqual({ done: 2, total: 3 });
    });

    test('counts nested items, however deep and however they are indented', () => {
        expect(parseChecklist('- [ ] parent\n  - [x] child\n    - [x] grandchild\n\t- [ ] tab')).toEqual({ done: 2, total: 4 });
    });

    test('an item sits among other text, and its box must be a space or an x with a space or the line\'s end after it', () => {
        expect(parseChecklist('Steps:\n\n- [x] first\n\nSome text\n\n- [ ] second')).toEqual({ done: 1, total: 2 });
        expect(parseChecklist('- [ ]')).toEqual({ done: 0, total: 1 });
        expect(parseChecklist('- [x]no space')).toBeUndefined();
        expect(parseChecklist('- [] empty box')).toBeUndefined();
        expect(parseChecklist('- [y] other mark')).toBeUndefined();
        expect(parseChecklist('-[ ] no space after the bullet')).toBeUndefined();
        expect(parseChecklist('1. [ ] numbered')).toBeUndefined();
        expect(parseChecklist('text - [ ] inside a sentence')).toBeUndefined();
        expect(parseChecklist('> - [ ] quoted')).toBeUndefined();
    });

    test('lines inside a fenced code block are code and do not count', () => {
        const text = ['- [x] real', '```md', '- [ ] in a backtick fence', '- [x] another', '```', '~~~', '- [ ] in a tilde fence', '~~~', '- [ ] real too'].join('\n');

        expect(parseChecklist(text)).toEqual({ done: 1, total: 2 });
    });

    test('a fence ends only at the same mark, at least as long, with nothing after it', () => {
        const text = ['````', '```', '- [ ] still code', '~~~~', '```js', '- [ ] still code', '````', '- [x] real'].join('\n');

        expect(parseChecklist(text)).toEqual({ done: 1, total: 1 });
    });

    test('a fence nested in an item is indented and still a fence; one that is never closed runs to the end', () => {
        expect(parseChecklist('- [ ] a\n  ```\n  - [ ] code\n  ```\n- [x] b')).toEqual({ done: 1, total: 2 });
        expect(parseChecklist('- [x] a\n```\n- [ ] code with no end\n- [ ] more')).toEqual({ done: 1, total: 1 });
    });

    test('a line of inline code that starts with backticks does not open a fence', () => {
        expect(parseChecklist('```not a fence``` on one line\n- [ ] counts')).toEqual({ done: 0, total: 1 });
    });
});
