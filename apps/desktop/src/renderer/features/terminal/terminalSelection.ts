/** A buffer row, as xterm's line is: `startColumn` inclusive, `endColumn` exclusive. */
export interface BufferRow {
    translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

/** The selection's ends, in xterm's own numbers: columns and rows are 0-based, and the end column is exclusive. */
export interface BufferSelection {
    start: { x: number; y: number };
    end: { x: number; y: number };
}

/** The lines a quote names: 1-based, the last one included, and the words of those rows. */
export interface QuotedRows {
    from: number;
    to: number;
    text: string;
}

/**
 * The buffer rows a terminal selection covers, numbered as the log file numbers them: line 1 is the first row of the active buffer, and each row stays its own
 * line. Nothing when the selection is empty or only blank. A selection that ends at the start of a row does not include that row.
 */
export function selectedBufferRows(lineAt: (index: number) => BufferRow | undefined, range: BufferSelection): QuotedRows | undefined {
    const { start, end } = range;

    if (end.y < start.y || (end.y === start.y && end.x <= start.x)) return undefined;

    const last = end.x === 0 && end.y > start.y ? end.y - 1 : end.y;
    const lines: string[] = [];

    for (let y = start.y; y <= last; y++) {
        const startColumn = y === start.y ? start.x : 0;
        const endColumn = y === end.y ? end.x : undefined;

        lines.push(lineAt(y)?.translateToString(true, startColumn, endColumn) ?? '');
    }

    const text = lines.join('\n');

    if (!text.trim()) return undefined;

    return { from: start.y + 1, to: start.y + lines.length, text };
}
