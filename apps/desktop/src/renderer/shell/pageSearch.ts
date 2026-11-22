/**
 * Search of the text drawn in the window, done in the page: it walks the text nodes, finds the query in them and paints the hits with the CSS
 * Custom Highlight API. Chromium's own `findInPage` was dropped because it searches the find bar's field too, takes the focus off it when it
 * selects a hit, and cannot be told to skip an element.
 */

const MATCHES = 'find';
const ACTIVE = 'find-active';

/**
 * Elements whose text is not drawn as text of the page: a field's value, code, a template, an SVG's title and description. Matched by `localName`,
 * which is lower case for HTML and for SVG alike (`tagName` of an SVG element is not upper case, and Chromium gives its `style` and `title` `display: inline`).
 */
const SKIPPED_TAGS = new Set(['script', 'style', 'noscript', 'template', 'textarea', 'input', 'select', 'option', 'title', 'desc', 'metadata']);

const WHITESPACE = /\s/u;

/** The query is folded the same way as the page's text, with its own runs of space made one. */
function foldQuery(query: string): string {
    return foldText(query, true, false).folded;
}

/**
 * Case and whitespace do not matter to the search. In text that collapses its whitespace (everything but `pre`) a run of spaces and line breaks is one
 * space, as it is drawn, and none after another space or at the start of a line; `map` then says where each character of the result stood in the node.
 * Otherwise each character maps to one character, so `map` is `null` and a position in the folded text is a position in the node.
 */
function foldText(text: string, collapse: boolean, afterSpace: boolean): { folded: string; map: number[] | null; endsWithSpace: boolean } {
    let folded = '';
    let map: number[] | null = null;
    let index = 0;
    let space = afterSpace;

    for (const char of text) {
        let next: string;

        if (WHITESPACE.test(char)) {
            if (!collapse) next = char === '\n' ? '\n' : ' ';
            else if (space) {
                // The identity until now, since nothing was dropped yet.
                map ??= Array.from({ length: folded.length }, (_, position) => position);
                index += char.length;

                continue;
            }
            else next = ' ';

            space = collapse;
        }
        else {
            const lower = char.toLowerCase();

            next = lower.length === char.length ? lower : char;
            space = false;
        }

        folded += next;

        if (map) for (let unit = 0; unit < next.length; unit += 1) map.push(index + unit);

        index += char.length;
    }

    return { folded, map, endsWithSpace: space };
}

interface Piece {
    node: Text;
    /** Where this node's folded text starts in the text of the whole walk. */
    start: number;
    /** Where each character of the folded text stood in the node, when some were dropped. */
    map: number[] | null;
}

/** Display values whose text runs on into the next text: a hit may cross them (`wor<b>ld</b>`). Everything else, a paragraph, a cell, a flex item, ends the run. */
function isInline(display: string): boolean {
    return display === '' || display === 'inline' || display === 'contents' || display.startsWith('inline-') || display === 'ruby' || display === 'ruby-text';
}

function collapsesSpace(whiteSpace: string): boolean {
    return whiteSpace !== 'pre' && whiteSpace !== 'pre-wrap' && whiteSpace !== 'break-spaces';
}

/**
 * Every text of the page that is drawn, in reading order, as one string with a line break between blocks and at `<br>`, so a query cannot match
 * across two paragraphs. `skip` is left out with all it holds (the find bar itself).
 */
function collect(root: Node, skip: Element | null): { text: string; pieces: Piece[] } {
    const styles = new Map<Element, CSSStyleDeclaration>();
    const blocks = new Map<Element, Element | null>();
    const styleOf = (element: Element) => {
        let style = styles.get(element);

        if (!style) {
            style = getComputedStyle(element);
            styles.set(element, style);
        }

        return style;
    };
    const blockOf = (element: Element | null): Element | null => {
        if (!element) return null;

        const known = blocks.get(element);

        if (known !== undefined) return known;

        const block = isInline(styleOf(element).display) ? blockOf(element.parentElement) : element;

        blocks.set(element, block);

        return block;
    };

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (node.nodeType === Node.TEXT_NODE) {
                const parent = node.parentElement;

                if (!parent) return NodeFilter.FILTER_REJECT;

                const { visibility } = styleOf(parent);

                return visibility === 'hidden' || visibility === 'collapse' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
            }

            const element = node as Element;

            if (element === skip || SKIPPED_TAGS.has(element.localName)) return NodeFilter.FILTER_REJECT;

            const style = styleOf(element);

            if (style.display === 'none' || style.contentVisibility === 'hidden') return NodeFilter.FILTER_REJECT;

            return element.tagName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        },
    });

    const parts: string[] = [];
    const pieces: Piece[] = [];
    let length = 0;
    /** The block of the last text, `undefined` at the start of a line (the first text, or after a `<br>`). */
    let block: Element | null | undefined;
    let space = true;
    let broken = true;

    const lineBreak = () => {
        if (!broken) {
            parts.push('\n');
            length += 1;
            broken = true;
        }

        block = undefined;
        space = true;
    };

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeType !== Node.TEXT_NODE) {
            lineBreak();

            continue;
        }

        const text = node as Text;
        const next = blockOf(text.parentElement);

        // Another block than the last text's: a line break between them, which no query has.
        if (block !== undefined && block !== next) lineBreak();

        const { folded, map, endsWithSpace } = foldText(text.data, collapsesSpace(styleOf(text.parentElement!).whiteSpace), space);

        block = next;

        if (folded === '') continue;

        space = endsWithSpace;
        broken = false;
        pieces.push({ node: text, start: length, map });
        parts.push(folded);
        length += folded.length;
    }

    return { text: parts.join(''), pieces };
}

/** The node and offset that a position in the folded text stands for. `pieces` ascend, and so do the positions asked for. */
function pointAt(pieces: Piece[], from: number, position: number, atEnd: boolean): { index: number; node: Text; offset: number } {
    let index = from;

    // A start at the end of one node is the start of the next; an end at the end of one node stays in it.
    while (index < pieces.length - 1 && (atEnd ? position > pieces[index + 1].start : position >= pieces[index + 1].start)) index += 1;

    const { node, start, map } = pieces[index];
    const inside = position - start;

    if (!map) return { index, node, offset: Math.min(node.data.length, inside) };

    // The end is after the last character that is in the hit, so a run of space that was one space ends the hit at its first character.
    const offset = atEnd ? (inside === 0 ? 0 : map[inside - 1] + 1) : (map[inside] ?? node.data.length);

    return { index, node, offset: Math.min(node.data.length, offset) };
}

/**
 * The ranges of every place the query stands in the text drawn in `root`, in reading order, not counting the find bar (`skip`). Case and whitespace
 * do not matter. A query that is empty finds nothing.
 */
export function findMatches(query: string, skip: Element | null = null, root: Node = document.body): Range[] {
    const needle = foldQuery(query);

    if (needle.trim() === '') return [];

    const { text, pieces } = collect(root, skip);
    const ranges: Range[] = [];
    let cursor = 0;

    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
        const start = pointAt(pieces, cursor, at, false);
        const end = pointAt(pieces, start.index, at + needle.length, true);
        const range = document.createRange();

        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
        ranges.push(range);
        cursor = start.index;
    }

    return ranges;
}

/** Where a range starts, against another's start: before it (negative), the same, or after it. */
function compare(range: Range, other: Range): number {
    return range.compareBoundaryPoints(Range.START_TO_START, other);
}

/** The index of the first hit that starts at `from` or after it (`strict`: after it). The hits are in reading order, so it is a binary search: a broad query has tens of thousands. */
function firstFrom(matches: readonly Range[], from: Range, strict: boolean): number {
    let low = 0;
    let high = matches.length;

    while (low < high) {
        const middle = (low + high) >>> 1;
        const order = compare(matches[middle], from);

        if (strict ? order <= 0 : order < 0) low = middle + 1;
        else high = middle;
    }

    return low;
}

/**
 * The index of the hit to go to from `from`: the next one after it, or the previous one before it, wrapping round the ends. With `inclusive`, a
 * hit that starts where `from` does counts as the next (typing more of the query stays on the hit). Without `from` it is the first, or the last
 * going backwards.
 */
export function stepFrom(matches: readonly Range[], from: Range | null, forward: boolean, inclusive = false): number {
    if (matches.length === 0) return -1;

    if (!from) return forward ? 0 : matches.length - 1;

    if (forward) {
        const next = firstFrom(matches, from, !inclusive);

        return next === matches.length ? 0 : next;
    }

    const previous = firstFrom(matches, from, false) - 1;

    return previous < 0 ? matches.length - 1 : previous;
}

function scrolls(element: Element): boolean {
    const { overflowY } = getComputedStyle(element);

    return (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') && element.scrollHeight > element.clientHeight;
}

/** Scrolls what holds the hit, the nearest scroller first, so it is in the middle of each. A hit that is in view stays where it is. */
export function revealMatch(range: Range): void {
    for (let holder = range.startContainer.parentElement; holder; holder = holder.parentElement) {
        if (!scrolls(holder)) continue;

        const box = range.getClientRects()[0] ?? range.getBoundingClientRect();
        const view = holder.getBoundingClientRect();

        if (box.top >= view.top && box.bottom <= view.bottom) continue;

        holder.scrollTop += box.top + box.height / 2 - (view.top + view.height / 2);
    }
}

function highlights(): HighlightRegistry | null {
    return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined' ? CSS.highlights : null;
}

/** Paints every hit, and the active one over them (`::highlight(find)` and `::highlight(find-active)` in the find bar's stylesheet). */
export function paintMatches(matches: readonly Range[], active: number): void {
    const registry = highlights();

    if (!registry) return;

    if (matches.length === 0) {
        clearMatches();

        return;
    }

    // One by one: a query of one letter can have more hits than a call can take as arguments.
    const all = new Highlight();
    const current = new Highlight(matches[active]);

    for (const range of matches) all.add(range);

    current.priority = 1;
    registry.set(MATCHES, all);
    registry.set(ACTIVE, current);
}

export function clearMatches(): void {
    const registry = highlights();

    registry?.delete(MATCHES);
    registry?.delete(ACTIVE);
}
