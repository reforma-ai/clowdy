/** A longest-common-subsequence table above this many cells is not worth building; the lines in the middle all show as changed. */
const MAX_CELLS = 2_000_000;

export interface ChangedLines {
    /** One flag per line of the first text: it has no counterpart in the second. */
    mine: boolean[];
    theirs: boolean[];
}

/** The lines of two texts that differ, for a side-by-side view: what is left after the lines they have in common, in order. */
export function changedLines(mine: string, theirs: string): ChangedLines {
    const a = mine.split('\n');
    const b = theirs.split('\n');
    const flagsA = new Array<boolean>(a.length).fill(false);
    const flagsB = new Array<boolean>(b.length).fill(false);
    let start = 0;
    let endA = a.length;
    let endB = b.length;

    while (start < endA && start < endB && a[start] === b[start]) start++;

    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }

    const rows = endA - start;
    const columns = endB - start;

    if (rows * columns > MAX_CELLS) {
        flagsA.fill(true, start, endA);
        flagsB.fill(true, start, endB);

        return { mine: flagsA, theirs: flagsB };
    }

    // common[i][j]: how many lines the tails a[start + i ..] and b[start + j ..] have in common.
    const width = columns + 1;
    const common = new Uint32Array((rows + 1) * width);

    for (let i = rows - 1; i >= 0; i--) {
        for (let j = columns - 1; j >= 0; j--) {
            common[i * width + j] = a[start + i] === b[start + j]
                ? common[(i + 1) * width + j + 1]! + 1
                : Math.max(common[(i + 1) * width + j]!, common[i * width + j + 1]!);
        }
    }

    let i = 0;
    let j = 0;

    while (i < rows && j < columns) {
        if (a[start + i] === b[start + j]) {
            i++;
            j++;
        }
        else if (common[(i + 1) * width + j]! >= common[i * width + j + 1]!) {
            flagsA[start + i++] = true;
        }
        else {
            flagsB[start + j++] = true;
        }
    }

    flagsA.fill(true, start + i, endA);
    flagsB.fill(true, start + j, endB);

    return { mine: flagsA, theirs: flagsB };
}
