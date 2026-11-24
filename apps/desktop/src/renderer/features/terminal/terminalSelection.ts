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

/** The gap kept between the button and the screen's right edge, the same one the file editor keeps. */
const EDGE_GAP = 8;

/** Where the Add to chat button stands, in px inside the terminal's screen. */
export interface QuoteButtonPlace {
    left: number;
    top: number;
}

/**
 * Where the Add to chat button stands: just under the end of the selection, pulled back inside the screen when that end is past the right
 * edge, as the button over a file is. Nothing when that row is scrolled out of the screen. A selection that ends at the start of a row ends
 * on the row before it, at the screen's right edge.
 */
export function quoteButtonPlace(input: {
    startY: number;
    endX: number;
    endY: number;
    viewportY: number;
    cols: number;
    rows: number;
    cellWidth: number;
    cellHeight: number;
    buttonWidth: number;
    buttonHeight: number;
}): QuoteButtonPlace | undefined {
    const endsOnNextRow = input.endX === 0 && input.endY > input.startY;
    const row = endsOnNextRow ? input.endY - 1 : input.endY;
    const column = endsOnNextRow ? input.cols : input.endX;
    const viewRow = row - input.viewportY;

    if (viewRow < 0 || viewRow >= input.rows) return undefined;

    const screenWidth = input.cols * input.cellWidth;
    const screenHeight = input.rows * input.cellHeight;
    const maxLeft = Math.max(0, screenWidth - input.buttonWidth - EDGE_GAP);
    const left = Math.min(Math.max(column * input.cellWidth, 0), maxLeft);
    const below = (viewRow + 1) * input.cellHeight;
    const above = viewRow * input.cellHeight - input.buttonHeight;
    const top = below + input.buttonHeight <= screenHeight ? below : Math.max(0, above);

    return { left, top };
}
