import { describe, expect, it } from 'vitest';

import { dedentText, indentBlock, plural } from '../src/string';

describe('plural', () => {
    it('uses singular form for 1', () => {
        expect(plural(1, 'linter error', 'linter errors')).toBe('1 linter error');
    });

    it('uses plural form for other counts', () => {
        expect(plural(0, 'file', 'files')).toBe('0 files');
        expect(plural(2, 'file', 'files')).toBe('2 files');
    });
});

describe('indentBlock', () => {
    it('prefixes every line without trimming', () => {
        expect(indentBlock('<a>\n  b\n</a>', '   ')).toBe('   <a>\n     b\n   </a>');
    });
});

describe('dedentText', () => {
    it('returns empty-ish input unchanged', () => {
        expect(dedentText('')).toBe('');
        expect(dedentText('   \n  \n')).toBe('');
    });

    it('strips shared leading spaces from nested excerpts', () => {
        const nested = [
            '                        const items = useMemo(',
            '                            () => files.map(file => file),',
            '                            [files]',
            '                        );',
        ].join('\n');

        expect(dedentText(nested)).toBe(
            ['const items = useMemo(', '    () => files.map(file => file),', '    [files]', ');'].join('\n')
        );
    });

    it('leaves top-level code unchanged when min indent is zero', () => {
        const top = 'export function foo() {\n  return 1;\n}';

        expect(dedentText(top)).toBe(top);
    });

    it('recovers relative indent when the first line was left-trimmed', () => {
        // AST / prop preview after `.trim()`: first tag flush, children keep file indent.
        const trimmedExcerpt = [
            '<figure className="bg-poster-stage shadow-poster">',
            '            <Image',
            '              alt="poster"',
            '              src="/posters/poster-12.png"',
            '            />',
            '          </figure>',
        ].join('\n');

        expect(dedentText(trimmedExcerpt)).toBe(
            [
                '<figure className="bg-poster-stage shadow-poster">',
                '  <Image',
                '    alt="poster"',
                '    src="/posters/poster-12.png"',
                '  />',
                '</figure>',
            ].join('\n')
        );
    });

    it('recovers indent inside a flush brace-wrapped JSX attribute RHS', () => {
        // leftFigure={\n          <figure>…\n        } — `{` is flush, body keeps file indent.
        const braced = [
            '{',
            '          <figure className="bg-poster-stage shadow-poster">',
            '            <Image',
            '              alt="poster"',
            '              src="/posters/poster-12.png"',
            '            />',
            '          </figure>',
            '        }',
        ].join('\n');

        expect(dedentText(braced)).toBe(
            [
                '{',
                '  <figure className="bg-poster-stage shadow-poster">',
                '    <Image',
                '      alt="poster"',
                '      src="/posters/poster-12.png"',
                '    />',
                '  </figure>',
                '}',
            ].join('\n')
        );
    });
});
