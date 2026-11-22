/** The checklist of a Markdown text: how many of its `- [ ]` and `- [x]` lines there are, and how many are ticked. */
export interface Checklist {
    done: number;
    total: number;
}

/** A task-list line: a bullet (`-`, `*` or `+`), at any indent so nested items count, a box, and a space or the end of the line after it. */
const ITEM = /^[ \t]*[-*+][ \t]+\[([ xX])\](?:[ \t]|$)/;
const FENCE = /^[ \t]*(`{3,}|~{3,})(.*)$/;

/** The run of marks that opens or closes a fenced code block on this line; a backtick fence has no backtick in the rest of its line, or it is inline code. */
function fenceOf(line: string): string | undefined {
    const match = FENCE.exec(line);

    return match && !(match[1][0] === '`' && match[2].includes('`')) ? match[1] : undefined;
}

/**
 * The checklist a description holds, or nothing when it has no item. A checklist is plain Markdown, not a table: lines inside a fenced code block are
 * code and do not count, and the fence ends at a line of the same mark, at least as long, that carries nothing else (an unclosed one runs to the end).
 */
export function parseChecklist(markdown: string): Checklist | undefined {
    let open: string | undefined;
    let done = 0;
    let total = 0;

    for (const line of markdown.split(/\r?\n/)) {
        const mark = fenceOf(line);

        if (open !== undefined) {
            if (mark?.[0] === open[0] && mark.length >= open.length && line.trim() === mark) {
                open = undefined;
            }

            continue;
        }

        if (mark) {
            open = mark;
            continue;
        }

        const item = ITEM.exec(line);

        if (item) {
            total++;
            done += item[1] === ' ' ? 0 : 1;
        }
    }

    return total > 0 ? { done, total } : undefined;
}
