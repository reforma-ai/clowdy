// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearMatches, findMatches, paintMatches, revealMatch, stepFrom } from './pageSearch';

let host: HTMLDivElement;

const texts = (ranges: Range[]) => ranges.map(range => range.toString());

function draw(html: string) {
    host.innerHTML = html;
}

beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
});

afterEach(() => {
    host.remove();
});

describe('findMatches', () => {
    it('finds every place the query stands, in reading order, without caring about case', () => {
        draw('<p>Booking one</p><p>a BOOKING two, and booking three</p>');

        expect(texts(findMatches('booking'))).toEqual(['Booking', 'BOOKING', 'booking']);
    });

    it('finds Cyrillic text whatever its case', () => {
        draw('<p>Файл и ФАЙЛ</p>');

        expect(texts(findMatches('файл'))).toEqual(['Файл', 'ФАЙЛ']);
    });

    it('finds nothing for an empty query or one of spaces', () => {
        draw('<p>some words here</p>');

        expect(findMatches('')).toEqual([]);
        expect(findMatches('   ')).toEqual([]);
    });

    it('does not count the same text twice when the hits overlap', () => {
        draw('<p>aaa</p>');

        expect(texts(findMatches('aa'))).toEqual(['aa']);
    });

    it('finds a hit that runs across inline elements', () => {
        draw('<p>say wor<b>ld</b> <code>now</code></p>');

        const [hit] = findMatches('world now');

        expect(hit.toString()).toBe('world now');
    });

    it('counts a run of whitespace as one space, as the page draws it, and keeps the hit on the characters that are there', () => {
        draw('<p>one\n   two</p><p>say <b> loud</b></p>');

        expect(texts(findMatches('one two'))).toEqual(['one\n   two']);
        expect(texts(findMatches('say loud'))).toEqual(['say  loud']);
    });

    it('keeps a hit on the characters that are there when astral characters and collapsed whitespace come together', () => {
        draw('<p>😀  😀 book  and 😀   BOOK</p>');

        expect(texts(findMatches('book'))).toEqual(['book', 'BOOK']);
        expect(texts(findMatches('😀 book'))).toEqual(['😀 book', '😀   BOOK']);
        expect(texts(findMatches('😀 😀 book'))).toEqual(['😀  😀 book']);
    });

    it('starts a hit in the node it starts in and ends it in the node it ends in, where two nodes meet', () => {
        draw('<p>wor<b>ld</b></p>');

        const [before] = findMatches('wor');
        const [after] = findMatches('ld');
        const [across] = findMatches('rl');

        expect([before.endContainer.textContent, before.endOffset]).toEqual(['wor', 3]);
        expect([after.startContainer.textContent, after.startOffset]).toEqual(['ld', 0]);
        expect([
            across.startContainer.textContent,
            across.startOffset,
            across.endContainer.textContent,
            across.endOffset,
        ]).toEqual(['wor', 2, 'ld', 1]);
    });

    it('drops the space that starts a line, after a line break or a block, as the page does', () => {
        draw('<p>one<br> two</p><div>x</div> <div>  y</div>');

        expect(texts(findMatches('two'))).toEqual(['two']);
        expect(findMatches(' two')).toEqual([]);
        expect(texts(findMatches('y'))).toEqual(['y']);
        expect(findMatches(' y')).toEqual([]);
    });

    it('keeps the spaces and line breaks of preformatted text as they are', () => {
        draw('<pre style="white-space: pre">one\ntwo</pre>');

        expect(findMatches('one two')).toEqual([]);
        expect(texts(findMatches('one'))).toEqual(['one']);
    });

    it('keeps a hit from running across two blocks or a line break', () => {
        draw('<p>end of one</p><p>start of two</p><div>first<br>second</div>');

        expect(findMatches('oneStart')).toEqual([]);
        expect(findMatches('one start')).toEqual([]);
        expect(findMatches('firstsecond')).toEqual([]);
        expect(texts(findMatches('second'))).toEqual(['second']);
    });

    it("treats a line break inside a paragraph's text as a space", () => {
        draw('<p>one\n   two</p>');

        expect(findMatches('one two')).toHaveLength(1);
    });

    it('leaves out what is not drawn: display none, hidden, scripts, fields', () => {
        draw(`
            <p>shown needle</p>
            <p style="display: none">hidden needle</p>
            <div style="display: none"><span>nested needle</span></div>
            <p style="visibility: hidden">invisible needle</p>
            <script>needle</script>
            <textarea>needle in a field</textarea>
        `);

        // Not only one hit: the one that is drawn.
        expect(findMatches('needle').map(range => range.startContainer.textContent)).toEqual(['shown needle']);
    });

    it('leaves out the title, the description and the style of an SVG, which are not drawn as text', () => {
        draw(
            '<svg width="10" height="10"><title>needle title</title><desc>needle desc</desc><text x="0" y="8">needle drawn</text><style>.needle { fill: red }</style></svg>'
        );

        expect(findMatches('needle').map(range => range.startContainer.textContent)).toEqual(['needle drawn']);
    });

    it('leaves out the element it is told to skip, with everything inside it', () => {
        draw('<p>needle</p><div id="bar"><span>needle</span><input value="needle"></div>');

        const bar = host.querySelector('#bar')!;

        expect(findMatches('needle')).toHaveLength(2);
        expect(findMatches('needle', bar)).toHaveLength(1);
    });
});

describe('stepFrom', () => {
    const matches = () => {
        draw('<p>x one x two x three</p>');

        return findMatches('x');
    };

    it('starts at the first hit, or the last going back, with no place to start from', () => {
        const found = matches();

        expect(stepFrom(found, null, true)).toBe(0);
        expect(stepFrom(found, null, false)).toBe(2);
        expect(stepFrom([], null, true)).toBe(-1);
    });

    it('goes to the neighbour of the hit it is on, and round the end', () => {
        const found = matches();

        expect(stepFrom(found, found[0], true)).toBe(1);
        expect(stepFrom(found, found[1], true)).toBe(2);
        expect(stepFrom(found, found[2], true)).toBe(0);
        expect(stepFrom(found, found[2], false)).toBe(1);
        expect(stepFrom(found, found[0], false)).toBe(2);
    });

    it('stays on a hit that starts where the last one did when told it may', () => {
        const found = matches();

        expect(stepFrom(found, found[1], true, true)).toBe(1);
    });

    it('goes by the place it is given, not only by a hit: a hit that moved or a page that changed leaves a range between two hits', () => {
        draw('<p>x x x x x x x</p>');

        const found = findMatches('x');
        const text = host.querySelector('p')!.firstChild!;
        const between = document.createRange();

        // The hits stand at 0, 2, 4, ...: offset 3 is between the second and the third.
        between.setStart(text, 3);
        between.setEnd(text, 3);

        expect(stepFrom(found, between, true)).toBe(2);
        expect(stepFrom(found, between, true, true)).toBe(2);
        expect(stepFrom(found, between, false)).toBe(1);

        between.setStart(text, 13);
        between.setEnd(text, 13);

        // Past the last hit it wraps round to the first going on, and stands on the last going back.
        expect(stepFrom(found, between, true)).toBe(0);
        expect(stepFrom(found, between, false)).toBe(6);
    });

    it('finds the neighbour of every hit among many', () => {
        draw(`<p>${'x '.repeat(500)}</p>`);

        const found = findMatches('x');

        expect(found).toHaveLength(500);

        for (const index of [0, 1, 137, 498, 499]) {
            expect(stepFrom(found, found[index], true)).toBe((index + 1) % 500);
            expect(stepFrom(found, found[index], true, true)).toBe(index);
            expect(stepFrom(found, found[index], false)).toBe((index + 499) % 500);
        }
    });
});

describe('painting', () => {
    class FakeHighlight {
        ranges: Range[];
        priority = 0;

        constructor(...ranges: Range[]) {
            this.ranges = ranges;
        }

        add(range: Range) {
            this.ranges.push(range);
        }
    }

    const registry = new Map<string, FakeHighlight>();

    beforeEach(() => {
        registry.clear();
        vi.stubGlobal('Highlight', FakeHighlight);
        vi.stubGlobal('CSS', { highlights: registry });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('paints every hit, and the active one stronger over them', () => {
        draw('<p>x x x</p>');

        const found = findMatches('x');

        paintMatches(found, 1);

        expect(registry.get('find')?.ranges).toEqual(found);
        expect(registry.get('find-active')?.ranges).toEqual([found[1]]);
        expect(registry.get('find-active')!.priority).toBeGreaterThan(registry.get('find')!.priority);
    });

    it('takes the paint off when there is nothing to paint or it is cleared', () => {
        draw('<p>x</p>');
        paintMatches(findMatches('x'), 0);
        paintMatches([], 0);

        expect(registry.size).toBe(0);

        paintMatches(findMatches('x'), 0);
        clearMatches();

        expect(registry.size).toBe(0);
    });

    it('does nothing where the browser has no highlights', () => {
        vi.stubGlobal('CSS', {});
        draw('<p>x</p>');

        expect(() => paintMatches(findMatches('x'), 0)).not.toThrow();
        expect(() => clearMatches()).not.toThrow();
    });
});

describe('revealMatch', () => {
    it('centres a hit that is out of view in the scroller that holds it, and leaves one in view alone', () => {
        draw('<div id="scroller" style="overflow-y: auto"><p>needle</p></div>');

        const scroller = host.querySelector<HTMLElement>('#scroller')!;
        const [hit] = findMatches('needle');

        Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true });
        Object.defineProperty(scroller, 'clientHeight', { value: 100, configurable: true });
        scroller.getBoundingClientRect = () => ({
            top: 0,
            bottom: 100,
            height: 100,
            left: 0,
            right: 100,
            width: 100,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        });

        const rect = (top: number) => ({
            top,
            bottom: top + 20,
            height: 20,
            left: 0,
            right: 50,
            width: 50,
            x: 0,
            y: top,
            toJSON: () => ({}),
        });

        hit.getClientRects = () => [rect(500)] as unknown as DOMRectList;
        revealMatch(hit);

        expect(scroller.scrollTop).toBe(460);

        scroller.scrollTop = 0;
        hit.getClientRects = () => [rect(40)] as unknown as DOMRectList;
        revealMatch(hit);

        expect(scroller.scrollTop).toBe(0);
    });
});
