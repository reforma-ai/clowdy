import { describe, expect, it } from 'vitest';

import { personMarkdown } from './personMarkdown';

const tasks = new Map([['CAR-24', { id: 't-24', key: 'CAR-24', title: 'Rebuild the form' }]]);
const taskOfKey = (key: string) => tasks.get(key);

describe('personMarkdown', () => {
    it('turns a mentioned file into inline code, which the stream draws as a chip', () => {
        expect(personMarkdown('Look at @src/booking/price.ts now', taskOfKey)).toBe(
            'Look at `src/booking/price.ts` now'
        );
    });

    it('leaves the dot that ends a sentence outside the path', () => {
        expect(personMarkdown('Read @src/a.ts.', taskOfKey)).toBe('Read `src/a.ts`.');
        expect(personMarkdown('See (@src/a.ts)', taskOfKey)).toBe('See (`src/a.ts`)');
    });

    it('takes a quoted path with a space whole', () => {
        expect(personMarkdown('Open @"notes/my plan.md" please', taskOfKey)).toBe('Open `notes/my plan.md` please');
    });

    it('turns a key of a task the project has into inline code, and leaves any other key alone', () => {
        expect(personMarkdown('Do CAR-24 first, then CAR-99', taskOfKey)).toBe('Do `CAR-24` first, then CAR-99');
        expect(personMarkdown('Do CAR-24', undefined)).toBe('Do CAR-24');
    });

    it('leaves what is not a file alone', () => {
        expect(personMarkdown('mail me @home or at a@b.c', taskOfKey)).toBe('mail me @home or at a@b.c');
        expect(personMarkdown('the @decorator pattern', taskOfKey)).toBe('the @decorator pattern');
    });

    it('does not touch a fenced block', () => {
        const text = '```\n@src/a.ts and CAR-24\n```\nthen @src/a.ts';

        expect(personMarkdown(text, taskOfKey)).toBe('```\n@src/a.ts and CAR-24\n```\nthen `src/a.ts`');
    });

    it('does not break a path that holds a backtick', () => {
        expect(personMarkdown('@src/a`b.ts', taskOfKey)).toBe('@src/a`b.ts');
    });

    it('does not read a part of a URL as a mention', () => {
        const url = 'see https://cdn.example.com/npm/@scope/pkg@1.0.0/dist/index.js and https://a.b/@c.js';

        expect(personMarkdown(url, taskOfKey)).toBe(url);
    });

    it('does not touch inline code, where a branch name or a command may hold a key', () => {
        const text = 'use `feature/CAR-24-form` or `git checkout CAR-24` or ``@src/a.ts`` then @src/a.ts';

        expect(personMarkdown(text, taskOfKey)).toBe(
            'use `feature/CAR-24-form` or `git checkout CAR-24` or ``@src/a.ts`` then `src/a.ts`'
        );
    });

    it('takes a task key at the start of a word or in brackets and quotes, not in the middle of a name', () => {
        expect(personMarkdown('(CAR-24) and "CAR-24" and CAR-24-form and foo-CAR-24', taskOfKey)).toBe(
            '(`CAR-24`) and "`CAR-24`" and CAR-24-form and foo-CAR-24'
        );
    });

    it('closes a fenced block only with a fence of the same kind and length', () => {
        const nested = '````\n```\n@src/a.ts\n```\n@src/b.ts\n````\n@src/c.ts';
        const mixed = '```\n~~~\n@src/a.ts\n~~~\n```\n@src/b.ts';

        expect(personMarkdown(nested, taskOfKey)).toBe('````\n```\n@src/a.ts\n```\n@src/b.ts\n````\n`src/c.ts`');
        expect(personMarkdown(mixed, taskOfKey)).toBe('```\n~~~\n@src/a.ts\n~~~\n```\n`src/b.ts`');
    });

    it('does not take ```code``` on one line for a fence', () => {
        expect(personMarkdown('```code``` then @src/a.ts', taskOfKey)).toBe('```code``` then `src/a.ts`');
    });
});
