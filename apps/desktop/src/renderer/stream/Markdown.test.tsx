import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Markdown } from './Markdown';

const html = (text: string) => renderToStaticMarkup(<Markdown text={ text } />);

describe('Markdown', () => {
    it('renders emphasis, inline code, lists and links as elements', () => {
        const out = html('**Plan** with `code` and [a link](https://example.com).\n\n1. first\n2. second\n\n- a\n- b');

        expect(out).toContain('<strong>Plan</strong>');
        expect(out).toContain('<code>code</code>');
        expect(out).toContain('<a href="https://example.com" target="_blank" rel="noreferrer noopener">a link</a>');
        expect(out).toMatch(/<ol[^>]*><li[^>]*><span>first<\/span><\/li><li[^>]*><span>second<\/span><\/li><\/ol>/);
        expect(out).toContain('<ul>');
    });

    it('shows raw HTML as text instead of injecting it', () => {
        const out = html('Hello <img src=x onerror=alert(1)> and\n\n<script>alert(1)</script>');

        expect(out).not.toContain('<script');
        expect(out).not.toContain('<img');
        expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('turns a link with an unsafe protocol into plain text', () => {
        const out = html('[click](javascript:alert(1)) and [local](/etc/passwd) and [mail](mailto:a@b.co)');

        expect(out).not.toContain('javascript:');
        expect(out).not.toContain('href="/etc/passwd"');
        expect(out).toContain('href="mailto:a@b.co"');
        expect(out).toContain('click');
    });

    it('shows an image as its alt text and loads nothing', () => {
        const out = html('![a diagram](https://tracker.example/pixel.png)');

        expect(out).not.toContain('<img');
        expect(out).toContain('a diagram');
    });

    it('keeps an ampersand and angle brackets in text readable and escaped once', () => {
        expect(html('Tom & Jerry `a<b`')).toContain('Tom &amp; Jerry <code>a&lt;b</code>');
    });

    it('renders task lists with disabled checkboxes, and tables', () => {
        const out = html('- [x] done\n- [ ] open\n\n| a | b |\n|---|---|\n| 1 | 2 |');

        expect(out).toContain('checked=""');
        expect(out.match(/type="checkbox"/g)).toHaveLength(2);
        expect(out).toContain('<th>a</th>');
        expect(out).toContain('<td>2</td>');
    });
});
